'use strict';
const mqtt = require('mqtt');
const crypto = require('crypto');
const protobuf = require('protobufjs');
const path = require('path');
const db = require('./db');
const geo = require('./geo');
const logger = require('./logger');

let protoRoot = null;
let mqttClient = null;
let wsRef = null;
let currentConfig = null;

const PORTNUM = { TEXT: 1, POSITION: 3, NODEINFO: 4, TELEMETRY: 67 };

async function loadProto() {
  if (protoRoot) return protoRoot;
  protoRoot = await protobuf.load(path.join(__dirname, 'proto', 'meshtastic.proto'));
  return protoRoot;
}

function nodeIdHex(num) {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

// Meshtastic default channel key — used when PSK is AQ== (single byte 0x01)
// Defined in firmware channel.pb.h; NOT just 0x01 padded with zeros
const MESH_DEFAULT_KEY = Buffer.from([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01,
]);

function derivePskKey(pskB64) {
  const raw = Buffer.from(pskB64, 'base64');
  if (raw.length === 1 && raw[0] === 1) return MESH_DEFAULT_KEY;
  // 32-byte PSK → AES-256, otherwise AES-128
  const keyLen = raw.length >= 32 ? 32 : 16;
  const key = Buffer.alloc(keyLen, 0);
  raw.copy(key, 0, 0, Math.min(raw.length, keyLen));
  return key;
}

// Decrypt Meshtastic encrypted payload
function decryptPayload(encryptedBytes, packetId, fromNode, pskB64) {
  try {
    const key = derivePskKey(pskB64);
    const nonce = Buffer.alloc(16, 0);
    nonce.writeUInt32LE(packetId >>> 0, 0);
    nonce.writeUInt32LE(fromNode >>> 0, 8);
    const decipher = crypto.createDecipheriv('aes-128-ctr', key, nonce);
    return Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
  } catch (e) {
    return null;
  }
}

function setWs(ws) { wsRef = ws; }

function broadcast(type, data) {
  if (wsRef) wsRef.broadcast({ type, data });
}

// Persist position, update registry, check geofences & alerts
function handlePosition({ nodeId, lat, lon, altitude, speed, heading, snr, rssi, battery, timestamp }) {
  if (!nodeId || isNaN(lat) || isNaN(lon)) return;

  // Update registry — battery_level uses COALESCE so a position without battery data
  // doesn't overwrite a previously stored value from a telemetry or position packet.
  db.prepare(`
    INSERT INTO tracker_registry (node_id, last_seen, last_lat, last_lon, last_altitude, last_speed, battery_level, snr, rssi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      last_seen=excluded.last_seen, last_lat=excluded.last_lat,
      last_lon=excluded.last_lon, last_altitude=excluded.last_altitude,
      last_speed=excluded.last_speed,
      battery_level=COALESCE(excluded.battery_level, battery_level),
      snr=excluded.snr, rssi=excluded.rssi
  `).run(nodeId, timestamp, lat, lon, altitude ?? null, speed ?? null, battery ?? null, snr ?? null, rssi ?? null);

  // Store position history
  const activeRace = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (activeRace) {
    db.prepare(`
      INSERT INTO tracker_positions (race_id, node_id, lat, lon, altitude, speed, heading, battery, snr, rssi, timestamp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(activeRace.id, nodeId, lat, lon, altitude ?? null, speed ?? null, heading ?? null,
           battery ?? null, snr ?? null, rssi ?? null, timestamp);

    // Keep only last 500 positions per node per race
    db.prepare(`
      DELETE FROM tracker_positions WHERE id IN (
        SELECT id FROM tracker_positions WHERE race_id=? AND node_id=?
        ORDER BY timestamp DESC LIMIT -1 OFFSET 500
      )
    `).run(activeRace.id, nodeId);

    // Find matching participant
    const participant = findParticipant(nodeId, activeRace.id);
    if (participant) {
      checkGeofences(participant, activeRace, lat, lon, timestamp);
      checkOffCourse(participant, activeRace, lat, lon, timestamp);
      checkMissedStations(participant, activeRace, lat, lon, timestamp, speed);
    }
  }

  broadcast('position', { nodeId, lat, lon, altitude, speed, heading, battery, snr, rssi, timestamp });
}

function handleTelemetry({ nodeId, battery, voltage, timestamp }) {
  if (!nodeId) return;
  db.prepare(`
    INSERT INTO tracker_registry (node_id, battery_level, voltage, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      battery_level=excluded.battery_level, voltage=excluded.voltage, last_seen=excluded.last_seen
  `).run(nodeId, battery ?? null, voltage ?? null, timestamp);

  broadcast('tracker_info', { nodeId, battery, voltage, timestamp });
}

function handleNodeInfo({ nodeId, longName, shortName, hwModel, timestamp }) {
  if (!nodeId) return;
  db.prepare(`
    INSERT INTO tracker_registry (node_id, long_name, short_name, hw_model, last_seen)
    VALUES (?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET
      long_name=excluded.long_name, short_name=excluded.short_name,
      hw_model=excluded.hw_model, last_seen=excluded.last_seen
  `).run(nodeId, longName ?? null, shortName ?? null, hwModel ?? null, timestamp);

  broadcast('tracker_info', { nodeId, longName, shortName, timestamp });
}

function handleTextMessage({ fromNodeId, toNodeId, text, timestamp }) {
  const activeRace = db.prepare("SELECT id FROM races WHERE status='active' LIMIT 1").get();
  if (!activeRace) return;

  const reg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(fromNodeId);
  const fromName = reg ? (reg.long_name || reg.short_name || fromNodeId) : fromNodeId;

  // Find matching personnel name for sender
  const personnel = db.prepare(
    'SELECT name FROM personnel WHERE race_id=? AND tracker_id=? LIMIT 1'
  ).get(activeRace.id, fromNodeId);

  db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, to_node_id, from_name, to_name, text, timestamp)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(activeRace.id, 'in', fromNodeId, toNodeId,
         personnel ? personnel.name : fromName, null, text, timestamp);

  broadcast('message', {
    direction: 'in',
    from_node_id: fromNodeId,
    from_name: personnel ? personnel.name : fromName,
    text,
    timestamp,
  });
}

// Match nodeId (could be !hex, longname, or shortname) to a participant — case-insensitive
function findParticipant(nodeId, raceId) {
  const reg = db.prepare('SELECT long_name, short_name FROM tracker_registry WHERE node_id=?').get(nodeId);
  const ids = [nodeId, reg?.long_name, reg?.short_name].filter(Boolean);
  for (const id of ids) {
    const p = db.prepare(
      'SELECT * FROM participants WHERE race_id=? AND UPPER(tracker_id)=UPPER(?) LIMIT 1'
    ).get(raceId, id);
    if (p) return p;
  }
  return null;
}

// Geofence check: auto-log station timing events
const recentGeofenceEvents = new Map(); // key: `${participantId}_${stationId}_arrive/depart`

// Insert event, read back full joined row, then broadcast with consistent snake_case schema.
function emitGeofenceEvent(raceId, participant, eventType, station, timestamp) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp) VALUES (?,?,?,?,?)'
  ).run(raceId, participant.id, eventType, station.id, timestamp);

  const has_turnaround = !!(db.prepare(`
    SELECT 1 FROM events WHERE participant_id=? AND race_id=?
    AND station_id IN (SELECT id FROM stations WHERE race_id=? AND type='turnaround')
    LIMIT 1`).get(participant.id, raceId, raceId));

  const event = db.prepare(`
    SELECT e.*, p.bib, p.name as participant_name, s.name as station_name
    FROM events e
    LEFT JOIN participants p ON e.participant_id = p.id
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.id=?`).get(lastInsertRowid);

  logger.log('race', 'info', `${eventType.toUpperCase()} — ${participant.name} (#${participant.bib}) at ${station.name}`);
  broadcast('event', { ...event, has_turnaround });
}

function checkGeofences(participant, race, lat, lon, timestamp) {
  // Apply defaults before the guard so null columns (older races) behave the same as enabled.
  const autoStart = race.feat_auto_start ?? 1;
  const autoLog   = race.feat_auto_log   ?? 1;
  if (!autoLog && !autoStart) return;

  const stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(race.id);
  if (!stations.length) return;

  // Pre-find start station so the finish guard can check whether the participant
  // has cleared it. Only applies to 'finish' stations (start_finish is already
  // protected by the turnaround requirement).
  const startStn = stations.find(s => (s.type === 'start' || s.type === 'start_finish') && s.lat && s.lon);
  const startRadius = race.geofence_radius || 15;

  for (const station of stations) {
    if (!station.lat || !station.lon) continue;
    const dist = geo.haversine(lat, lon, station.lat, station.lon);
    const radius = ['start', 'finish', 'start_finish'].includes(station.type)
      ? (race.geofence_radius || 15)
      : (race.checkpoint_radius || 50);
    const inside = dist <= radius;
    const arriveKey = `${participant.id}_${station.id}_arrive`;
    const departKey = `${participant.id}_${station.id}_depart`;

    if (inside && !recentGeofenceEvents.has(arriveKey)) {
      recentGeofenceEvents.set(arriveKey, timestamp);
      setTimeout(() => recentGeofenceEvents.delete(arriveKey), 30000);

      let eventType = null;
      let statusSql = null;
      let statusArgs = null;

      if (station.type === 'start' && participant.status === 'dns') {
        // start fires on depart, not arrive — arriveKey already set above
      } else if (station.type === 'finish' && participant.status === 'active' && autoStart) {
        const clearOfStart = !startStn || !participant.start_time ||
          (timestamp - participant.start_time >= 20 * 60) ||
          geo.haversine(lat, lon, startStn.lat, startStn.lon) > startRadius;
        if (clearOfStart) {
          eventType = 'finish';
          statusSql = "UPDATE participants SET status='finished', finish_time=? WHERE id=?";
          statusArgs = [timestamp, participant.id];
        }
      } else if (station.type === 'start_finish') {
        if (participant.status === 'dns') {
          // start fires on depart, not arrive — arriveKey already set above
        } else if (participant.status === 'active' && autoStart) {
          const hasTurnaround = db.prepare(`
            SELECT 1 FROM events
            WHERE participant_id=? AND race_id=?
            AND station_id IN (SELECT id FROM stations WHERE race_id=? AND type='turnaround')
            LIMIT 1
          `).get(participant.id, race.id, race.id);
          if (hasTurnaround) {
            eventType = 'finish';
            statusSql = "UPDATE participants SET status='finished', finish_time=? WHERE id=?";
            statusArgs = [timestamp, participant.id];
          }
        }
      } else if (autoLog && (station.type === 'turnaround' || station.type === 'aid' || station.type === 'checkpoint')) {
        eventType = 'aid_arrive';
      }
      // netcontrol and repeater: no geofencing

      if (eventType) {
        if (statusSql) db.prepare(statusSql).run(...statusArgs);
        emitGeofenceEvent(race.id, participant, eventType, station, timestamp);
      }

    } else if (!inside && recentGeofenceEvents.has(arriveKey) && !recentGeofenceEvents.has(departKey)) {
      recentGeofenceEvents.set(departKey, timestamp);
      setTimeout(() => recentGeofenceEvents.delete(departKey), 30000);

      const isStartStation = station.type === 'start' ||
        (station.type === 'start_finish' && participant.status === 'dns');

      if (isStartStation && participant.status === 'dns' && autoStart) {
        db.prepare("UPDATE participants SET status='active', start_time=? WHERE id=?").run(timestamp, participant.id);
        emitGeofenceEvent(race.id, participant, 'start', station, timestamp);
      } else if (!['start', 'finish', 'start_finish'].includes(station.type)) {
        emitGeofenceEvent(race.id, participant, 'aid_depart', station, timestamp);
      }
    }
  }
}

// Track route data in memory for alert calculations
const routeCache = new Map(); // raceId -> { points, meta }

function getRouteData(race) {
  if (routeCache.has(race.id)) return routeCache.get(race.id);
  try {
    const fs = require('fs');
    let trackPoints = null;
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const raw = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./routes/courses');
        const parsed = parseCourse(raw, course.file_path, course.path_index);
        trackPoints = parsed.trackPoints;
      }
    }
    if (!trackPoints && race.track_file) {
      const raw = fs.readFileSync(race.track_file, 'utf8');
      const { parseTrack } = require('./routes/tracks');
      trackPoints = parseTrack(raw, race.track_file, race.track_path_index);
    }
    if (!trackPoints) return null;
    const meta = geo.buildTrackMeta(trackPoints);
    const data = { points: trackPoints, meta };
    routeCache.set(race.id, data);
    return data;
  } catch { return null; }
}

// Tracks stations we've already backfilled for a given participant this session
const backfilledStationEvents = new Set(); // `${participantId}_${stationId}`

function checkMissedStations(participant, race, lat, lon, timestamp, speed) {
  if (!(race.feat_auto_log ?? 1)) return;
  // Only run when the participant is clearly moving; avoids backfilling for a device
  // that just powered on after a long gap with no reliable position history.
  if (!speed || speed < 0.3) return;

  const route = getRouteData(race);
  if (!route) return;

  const { distanceAlongRoute: currentAlong } = geo.findPositionOnRoute(lat, lon, route.points, route.meta);

  // Only consider aid/checkpoint/turnaround stations with known coordinates
  const stations = db.prepare(
    `SELECT * FROM stations WHERE race_id=? AND type IN ('aid','checkpoint','turnaround')
     AND lat IS NOT NULL AND lon IS NOT NULL`
  ).all(race.id);

  const isOAB = race.race_format === 'out_and_back';
  // Return-leg detection: if OAB, check for a turnaround event
  const hasTurnaround = isOAB && !!(db.prepare(`
    SELECT 1 FROM events WHERE participant_id=? AND race_id=?
    AND station_id IN (SELECT id FROM stations WHERE race_id=? AND type='turnaround')
    LIMIT 1
  `).get(participant.id, race.id, race.id));

  // On the OAB return leg the station ordering reverses; skip for now to avoid
  // incorrect direction assumptions.
  if (isOAB && hasTurnaround) return;

  for (const station of stations) {
    const key = `${participant.id}_${station.id}`;
    if (backfilledStationEvents.has(key)) continue;

    const stationAlong = geo.findPositionOnRoute(
      station.lat, station.lon, route.points, route.meta
    ).distanceAlongRoute;

    // Participant must be this far past the station's geofence radius before we act
    const clearance = (race.checkpoint_radius || 50) + 50;
    if (currentAlong <= stationAlong + clearance) continue;

    // Skip if any event already exists for this participant at this station
    const existing = db.prepare(
      'SELECT 1 FROM events WHERE participant_id=? AND station_id=? LIMIT 1'
    ).get(participant.id, station.id);

    backfilledStationEvents.add(key);
    if (existing) continue;

    // Back-calculate when they were likely at the station using current speed
    const distPast = currentAlong - stationAlong;
    const secsAgo = Math.round(distPast / speed);
    const departTime = Math.max(
      participant.start_time || (timestamp - 7200),
      timestamp - secsAgo
    );

    const { lastInsertRowid } = db.prepare(
      `INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp, notes)
       VALUES (?,?,?,?,?,?)`
    ).run(race.id, participant.id, 'aid_depart', station.id, departTime, 'auto-backfilled');

    const event = db.prepare(`
      SELECT e.*, p.bib, p.name as participant_name, s.name as station_name
      FROM events e
      LEFT JOIN participants p ON e.participant_id = p.id
      LEFT JOIN stations s ON e.station_id = s.id
      WHERE e.id=?
    `).get(lastInsertRowid);

    logger.log('race', 'info',
      `AUTO-BACKFILL depart — ${participant.name} (#${participant.bib}) at ${station.name} (est. ${secsAgo}s ago)`);
    broadcast('event', { ...event, has_turnaround: hasTurnaround });
  }
}

const lastOffCourseAlert = new Map();

function checkOffCourse(participant, race, lat, lon, timestamp) {
  if (!race.feat_off_course || !race.off_course_distance) return;
  const route = getRouteData(race);
  if (!route) return;
  const { distanceFromRoute } = geo.findPositionOnRoute(lat, lon, route.points, route.meta);
  const alertKey = `${participant.id}_offcourse`;
  if (distanceFromRoute > race.off_course_distance) {
    const last = lastOffCourseAlert.get(alertKey) || 0;
    if (timestamp - last > 120) { // suppress repeat alerts for 2 min
      lastOffCourseAlert.set(alertKey, timestamp);
      logger.log('race', 'warn', `OFF COURSE — ${participant.name} (#${participant.bib}) ${Math.round(distanceFromRoute)}m from route`);
      broadcast('alert', {
        type: 'off_course',
        participantId: participant.id,
        bib: participant.bib,
        name: participant.name,
        distanceFromRoute: Math.round(distanceFromRoute),
        timestamp,
      });
    }
  } else {
    lastOffCourseAlert.delete(alertKey);
  }
}

// Process a decoded JSON-style message object (from MQTT JSON format)
function processJsonMessage(msg) {
  const fromHex = typeof msg.from === 'number' ? nodeIdHex(msg.from) : (msg.sender || msg.from || '');
  const ts = msg.timestamp || Math.floor(Date.now() / 1000);

  if (msg.type === 'position' && msg.payload) {
    const p = msg.payload;
    handlePosition({
      nodeId: fromHex,
      lat: (p.latitude_i ?? p.latitude ?? 0) / (p.latitude_i !== undefined ? 1e7 : 1),
      lon: (p.longitude_i ?? p.longitude ?? 0) / (p.longitude_i !== undefined ? 1e7 : 1),
      altitude: p.altitude,
      speed: p.ground_speed,
      heading: p.ground_track,
      battery: p.battery_level ?? null,
      snr: msg.snr,
      rssi: msg.rssi,
      timestamp: ts,
    });
  } else if (msg.type === 'telemetry' && msg.payload) {
    const p = msg.payload;
    handleTelemetry({ nodeId: fromHex, battery: p.battery_level, voltage: p.voltage, timestamp: ts });
  } else if (msg.type === 'nodeinfo' && msg.payload) {
    const p = msg.payload;
    handleNodeInfo({ nodeId: fromHex, longName: p.long_name, shortName: p.short_name, hwModel: p.hardware, timestamp: ts });
  } else if (msg.type === 'text') {
    const toHex = typeof msg.to === 'number' ? nodeIdHex(msg.to) : (msg.to || '');
    handleTextMessage({ fromNodeId: fromHex, toNodeId: toHex, text: msg.payload, timestamp: ts });
  }
}

// Process decoded protobuf Data object
async function processProtoData(data, fromNode, snr, rssi) {
  const root = await loadProto();
  const ts = Math.floor(Date.now() / 1000);
  const fromHex = nodeIdHex(fromNode);

  if (data.portnum === PORTNUM.POSITION) {
    const Position = root.lookupType('meshtastic.Position');
    const pos = Position.decode(data.payload);
    logger.log('mqtt', 'info', `position from ${fromHex}`);
    handlePosition({
      nodeId: fromHex,
      lat: pos.latitudeI / 1e7,
      lon: pos.longitudeI / 1e7,
      altitude: pos.altitude,
      speed: pos.groundSpeed,
      heading: pos.groundTrack,
      snr, rssi, timestamp: pos.time || ts,
    });
  } else if (data.portnum === PORTNUM.TELEMETRY) {
    const Telemetry = root.lookupType('meshtastic.Telemetry');
    const tel = Telemetry.decode(data.payload);
    if (tel.deviceMetrics) {
      handleTelemetry({ nodeId: fromHex, battery: tel.deviceMetrics.batteryLevel, voltage: tel.deviceMetrics.voltage, timestamp: ts });
    }
  } else if (data.portnum === PORTNUM.NODEINFO) {
    const User = root.lookupType('meshtastic.User');
    const user = User.decode(data.payload);
    handleNodeInfo({ nodeId: fromHex, longName: user.longName, shortName: user.shortName, hwModel: user.hwModel, timestamp: ts });
  } else if (data.portnum === PORTNUM.TEXT) {
    handleTextMessage({ fromNodeId: fromHex, toNodeId: '', text: data.payload.toString('utf8'), timestamp: ts });
  }
}

async function handleProtoMessage(payload, psk) {
  try {
    const root = await loadProto();
    const ServiceEnvelope = root.lookupType('meshtastic.ServiceEnvelope');
    const Data = root.lookupType('meshtastic.Data');
    const envelope = ServiceEnvelope.decode(payload);
    const packet = envelope.packet;
    if (!packet) return;

    let data;
    if (packet.decoded) {
      data = packet.decoded;
    } else if (packet.encrypted) {
      const decrypted = decryptPayload(Buffer.from(packet.encrypted), packet.id, packet.from, psk);
      if (!decrypted) return;
      try { data = Data.decode(decrypted); } catch { return; }
    } else return;

    await processProtoData(data, packet.from, packet.rxSnr, packet.rxRssi);
  } catch (e) {
    // silently ignore malformed packets
  }
}

function connectFromSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'mqtt_%'").all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!s.mqtt_host) return false;
  // mqtt_enabled defaults to '1' if never set (backward compat)
  if (s.mqtt_enabled === '0') { disconnect(); return false; }
  const protocol = s.mqtt_protocol || 'tcp';
  const defaultPort = protocol === 'ws' ? 9001 : 1883;
  connect({
    host: s.mqtt_host,
    port: parseInt(s.mqtt_port || s.mqtt_port_ws) || defaultPort,
    protocol,
    user: s.mqtt_user || '',
    pass: s.mqtt_pass || '',
    region: s.mqtt_region || 'US',
    channel: s.mqtt_channel || 'LongFast',
    format: s.mqtt_format || 'json',
    psk: s.mqtt_psk || 'AQ==',
    diagnostic: s.mqtt_diagnostic === '1',
  });
  return true;
}

function connect(config) {
  disconnect();
  currentConfig = config;
  const proto = config.protocol === 'ws' ? 'ws' : 'mqtt';
  const url = `${proto}://${config.host}:${config.port}`;
  const opts = {
    username: config.user || undefined,
    password: config.pass || undefined,
    reconnectPeriod: 5000,
  };
  const mqttLog = (level, msg) => { console.log(`[mqtt] ${msg}`); logger.log('mqtt', level, msg); };
  mqttLog('info', `Connecting to ${url} as ${config.user || '(anonymous)'}`);
  mqttClient = mqtt.connect(url, opts);

  mqttClient.on('connect', () => {
    mqttLog('info', `Connected to ${url}`);
    // Subscribe to both JSON and encrypted protobuf topic patterns simultaneously
    const jsonTopic = `msh/${config.region}/2/json/${config.channel}/#`;
    const encTopic  = `msh/${config.region}/2/e/${config.channel}/#`;
    [jsonTopic, encTopic].forEach(t => {
      mqttClient.subscribe(t, err => {
        if (err) mqttLog('error', `Subscribe error ${t}: ${err.message}`);
        else mqttLog('info', `Subscribed to ${t}`);
      });
    });
    // Diagnostic catch-all: log every topic for 60s to help identify traffic
    if (config.diagnostic) {
      mqttClient.subscribe('#', err => {
        if (!err) mqttLog('info', 'Diagnostic: subscribed to # (all topics for 60s)');
      });
      setTimeout(() => {
        if (mqttClient?.connected) {
          mqttClient.unsubscribe('#');
          mqttLog('info', 'Diagnostic: unsubscribed from #');
        }
      }, 60000);
    }
    broadcast('mqtt_status', { connected: true, host: config.host, topics: [jsonTopic, encTopic] });
  });

  mqttClient.on('message', async (topic, payload) => {
    if (config.diagnostic) {
      const preview = payload.slice(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
      mqttLog('debug', `topic=${topic} len=${payload.length} data=${preview}`);
    }
    try {
      // Detect format from topic path — /2/e/ = encrypted protobuf, /2/json/ = JSON
      if (/\/2\/e\//.test(topic)) {
        await handleProtoMessage(payload, config.psk);
      } else {
        const msg = JSON.parse(payload.toString());
        processJsonMessage(msg);
        if (msg.type === 'position' || msg.type === 'nodeinfo')
          mqttLog('info', `${msg.type} from ${msg.sender || msg.from} on ${topic}`);
      }
      broadcast('mqtt_raw', { topic, ts: Date.now() });
    } catch (e) {
      if (config.diagnostic) mqttLog('warn', `Parse error on ${topic}: ${e.message}`);
    }
  });

  mqttClient.on('error', err => {
    mqttLog('error', `Error: ${err.message}`);
    broadcast('mqtt_status', { connected: false, error: err.message });
  });

  mqttClient.on('close', () => {
    mqttLog('info', 'Connection closed');
    broadcast('mqtt_status', { connected: false });
  });
}

function disconnect() {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
  currentConfig = null;
  broadcast('mqtt_status', { connected: false, enabled: false });
}

function getStatus() {
  const enabled = !!(currentConfig);
  return { connected: !!(mqttClient && mqttClient.connected), enabled };
}

// Publish an outbound text message to a specific node
function publishMessage(toNodeId, text) {
  if (!mqttClient || !mqttClient.connected || !currentConfig) return false;
  const topic = `msh/${currentConfig.region}/2/json/${currentConfig.channel}/!server`;
  const payload = JSON.stringify({
    from: 0,
    to: toNodeId,
    type: 'text',
    payload: text,
    timestamp: Math.floor(Date.now() / 1000),
  });
  mqttClient.publish(topic, payload);
  return true;
}

function invalidateRouteCache(raceId) {
  routeCache.delete(raceId);
  // Clear backfill cache so stations are re-evaluated against the new route
  for (const key of backfilledStationEvents) {
    backfilledStationEvents.delete(key);
  }
}

module.exports = { connect, connectFromSettings, disconnect, getStatus, setWs, publishMessage, invalidateRouteCache, handlePosition, handleTelemetry };
