'use strict';
const mqtt   = require('mqtt');
const db     = require('./db');
const geo    = require('./geo');

// SSE broadcast function — injected by index.js after startup
let broadcast = () => {};
function setBroadcast(fn) { broadcast = fn; }

// Active MQTT client per race
const clients = new Map(); // race_id -> mqtt.Client

// In-memory route cache to avoid re-parsing SQLite on every packet
const routeCache = new Map(); // race_id -> { points:[{lat,lng}], cumDist:[] }

// In-memory "last alert time" to throttle repeated off-course/missing alerts
const alertThrottle = new Map(); // `${race_id}:${tracker_id}:${type}` -> unix ms

// Missing-timer checker interval handle per race
const missingTimers = new Map(); // race_id -> setInterval handle

function getRoute(raceId) {
  if (routeCache.has(raceId)) return routeCache.get(raceId);

  const race = db.prepare('SELECT course_file_id, selected_path_index FROM races WHERE id=?').get(raceId);
  if (!race || !race.course_file_id) return null;

  const file = db.prepare('SELECT filename FROM course_files WHERE id=?').get(race.course_file_id);
  if (!file) return null;

  const path = require('path');
  const fs   = require('fs');
  const fPath = path.join(__dirname, '..', 'data', 'tracks', file.filename);
  if (!fs.existsSync(fPath)) return null;

  const raw = fs.readFileSync(fPath, 'utf8');
  const points = parseRouteFile(raw, file.filename, race.selected_path_index);
  if (!points || points.length < 2) return null;

  const cumDist = geo.buildCumulativeDist(points);
  const entry = { points, cumDist };
  routeCache.set(raceId, entry);
  return entry;
}

function invalidateRouteCache(raceId) {
  routeCache.delete(raceId);
}

function parseRouteFile(raw, filename, pathIndex) {
  if (filename.toLowerCase().endsWith('.gpx')) return parseGPX(raw);
  return parseKML(raw, pathIndex);
}

function parseKML(txt, idx) {
  const paths = [];
  const re = /<LineString[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const pts = m[1].trim().split(/\s+/).map(c => {
      const p = c.split(',');
      return p.length >= 2 ? { lat: parseFloat(p[1]), lng: parseFloat(p[0]) } : null;
    }).filter(Boolean);
    if (pts.length >= 2) paths.push(pts);
  }
  return paths[idx] || paths[0] || null;
}

function parseGPX(txt) {
  const pts = [];
  const re = /<trkpt[^>]+lat="([^"]+)"[^>]+lon="([^"]+)"/g;
  let m;
  while ((m = re.exec(txt)) !== null) pts.push({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
  return pts.length >= 2 ? pts : null;
}

function handlePosition(raceId, race, trackerId, lat, lng, meta) {
  const now = Date.now();

  // Persist position
  db.prepare(`
    INSERT INTO position_log (race_id, tracker_id, lat, lng, altitude_m, speed_ms, battery_pct, snr, rssi, rx_time, raw_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(raceId, trackerId, lat, lng,
    meta.altitude ?? null, meta.speed ?? null, meta.battery ?? null,
    meta.snr ?? null, meta.rssi ?? null, now, meta.raw ?? null);

  // Find participant by tracker_id
  const participant = db.prepare(
    'SELECT * FROM participants WHERE race_id=? AND tracker_id=? LIMIT 1'
  ).get(raceId, trackerId);

  // Compute progress along route
  const route = getRoute(raceId);
  let progressPct = null;
  let distFromRoute = null;
  if (route) {
    progressPct  = geo.progressAlongRoute(lat, lng, route.points, route.cumDist) * 100;
    distFromRoute = geo.distToRoute(lat, lng, route.points);
  }

  // Geofence check — auto-detect aid station arrivals
  if (participant && participant.status === 'active' && route) {
    const stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY order_index').all(raceId);
    for (const stn of stations) {
      const dist = geo.haversine(lat, lng, stn.lat, stn.lng);
      if (dist <= race.geofence_radius_m) {
        // Only fire once per station per participant (no duplicate events within 2 min)
        const recent = db.prepare(`
          SELECT id FROM timing_events
          WHERE race_id=? AND participant_id=? AND station_id=? AND event_type='arrive'
            AND event_time > ?
        `).get(raceId, participant.id, stn.id, now - 120000);
        if (!recent) {
          db.prepare(`
            INSERT INTO timing_events (race_id, participant_id, station_id, event_type, event_time, auto_detected, entered_by)
            VALUES (?,?,?,'arrive',?,1,'system')
          `).run(raceId, participant.id, stn.id, now);
          broadcast(raceId, { type: 'timing', event: 'arrive',
            participant_id: participant.id, station_id: stn.id, event_time: now, auto: true });
        }
      }
    }
  }

  // Off-course alert
  if (race.off_course_alerts && distFromRoute !== null && participant) {
    if (distFromRoute > race.off_course_distance_m) {
      const key = `${raceId}:${trackerId}:off_course`;
      const last = alertThrottle.get(key) || 0;
      if (now - last > 300000) { // 5-minute throttle
        alertThrottle.set(key, now);
        db.prepare(`
          INSERT INTO alerts (race_id, participant_id, alert_type, triggered_at, details)
          VALUES (?,?,'off_course',?,?)
        `).run(raceId, participant.id, now,
          JSON.stringify({ dist: Math.round(distFromRoute), lat, lng }));
        broadcast(raceId, {
          type: 'alert', alert_type: 'off_course',
          participant_id: participant.id, tracker_id: trackerId,
          dist: Math.round(distFromRoute), lat, lng, triggered_at: now
        });
      }
    }
  }

  // Broadcast position update to all SSE clients for this race
  broadcast(raceId, {
    type: 'position',
    tracker_id: trackerId,
    lat, lng,
    altitude_m:  meta.altitude  ?? null,
    speed_ms:    meta.speed     ?? null,
    battery_pct: meta.battery   ?? null,
    snr:         meta.snr       ?? null,
    rssi:        meta.rssi      ?? null,
    rx_time:     now,
    participant_id: participant?.id ?? null,
    progress_pct:   progressPct !== null ? +progressPct.toFixed(2) : null
  });
}

function parseMeshtasticJSON(payload, raceId) {
  try {
    const msg = JSON.parse(payload.toString());
    const pos = msg.payload;
    if (!pos || typeof pos.latitude_i === 'undefined') return null;
    return {
      trackerId: msg.from ? String(msg.from) : null,
      lat:  pos.latitude_i  / 1e7,
      lng:  pos.longitude_i / 1e7,
      meta: {
        altitude: pos.altitude   ?? null,
        speed:    pos.ground_speed ? pos.ground_speed / 100 : null,
        battery:  msg.payload?.device_metrics?.battery_level ?? null,
        snr:      msg.rx_snr  ?? null,
        rssi:     msg.rx_rssi ?? null,
        raw:      payload.toString()
      }
    };
  } catch { return null; }
}

function startBridge(raceId) {
  if (clients.has(raceId)) return;

  const race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
  if (!race) return;

  const proto = race.mqtt_tls ? 'wss' : 'ws';
  const url   = `${proto}://${race.mqtt_host}:${race.mqtt_port}`;
  const topic = `msh/${race.mqtt_region}/2/json/${race.mqtt_channel}/#`;

  const opts = { reconnectPeriod: 5000 };
  if (race.mqtt_user) { opts.username = race.mqtt_user; opts.password = race.mqtt_pass; }

  const client = mqtt.connect(url, opts);
  clients.set(raceId, client);

  client.on('connect', () => {
    client.subscribe(topic);
    broadcast(raceId, { type: 'mqtt_status', status: 'connected', host: race.mqtt_host });
  });

  client.on('error', err => {
    broadcast(raceId, { type: 'mqtt_status', status: 'error', message: err.message });
  });

  client.on('close', () => {
    broadcast(raceId, { type: 'mqtt_status', status: 'disconnected' });
  });

  client.on('message', (t, payload) => {
    const parsed = parseMeshtasticJSON(payload, raceId);
    if (!parsed || !parsed.trackerId) return;
    const r = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
    if (!r || r.status !== 'active') return;
    handlePosition(raceId, r, parsed.trackerId, parsed.lat, parsed.lng, parsed.meta);
  });

  // Missing-tracker checker (runs every minute)
  const missingInterval = setInterval(() => {
    const r = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
    if (!r || r.status !== 'active') return;
    const cutoff = Date.now() - r.missing_timer_min * 60000;
    const actives = db.prepare(
      "SELECT * FROM participants WHERE race_id=? AND status='active'"
    ).all(raceId);
    for (const p of actives) {
      if (!p.tracker_id) continue;
      const last = db.prepare(
        'SELECT rx_time FROM position_log WHERE race_id=? AND tracker_id=? ORDER BY rx_time DESC LIMIT 1'
      ).get(raceId, p.tracker_id);
      if (!last || last.rx_time < cutoff) {
        const key = `${raceId}:${p.tracker_id}:missing`;
        const prev = alertThrottle.get(key) || 0;
        if (Date.now() - prev > r.missing_timer_min * 60000) {
          alertThrottle.set(key, Date.now());
          db.prepare(
            "INSERT INTO alerts (race_id, participant_id, alert_type, triggered_at, details) VALUES (?,?,'missing',?,?)"
          ).run(raceId, p.id, Date.now(), JSON.stringify({ last_seen: last?.rx_time ?? null }));
          broadcast(raceId, {
            type: 'alert', alert_type: 'missing',
            participant_id: p.id, tracker_id: p.tracker_id,
            last_seen: last?.rx_time ?? null, triggered_at: Date.now()
          });
        }
      }
    }
  }, 60000);
  missingTimers.set(raceId, missingInterval);
}

function stopBridge(raceId) {
  const client = clients.get(raceId);
  if (client) { client.end(true); clients.delete(raceId); }
  const timer = missingTimers.get(raceId);
  if (timer) { clearInterval(timer); missingTimers.delete(raceId); }
  routeCache.delete(raceId);
}

function restartBridge(raceId) {
  stopBridge(raceId);
  startBridge(raceId);
}

// On server start, resume bridges for all active races
function resumeActiveBridges() {
  const actives = db.prepare("SELECT id FROM races WHERE status='active'").all();
  for (const r of actives) startBridge(r.id);
}

module.exports = { setBroadcast, startBridge, stopBridge, restartBridge,
                   resumeActiveBridges, invalidateRouteCache };
