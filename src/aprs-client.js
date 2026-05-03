'use strict';
const net = require('net');
const db = require('./db');
const geo = require('./geo');
const logger = require('./logger');

let socket = null;
let wsRef = null;
let currentConfig = null;
let lineBuffer = '';
let reconnectTimer = null;
let _connected = false;
let _messagingCallsign = null; // set to logged-in user's callsign when available

// Matches bare callsign or callsign-SSID (1–6 alphanum chars, SSID 1–15)
const APRS_CALL_RE = /^[A-Z0-9]{1,6}(-(?:1[0-5]|[0-9]))?$/;

// Byham APRS passcode algorithm
function generatePasscode(callsign) {
  const base = callsign.toUpperCase().split('-')[0];
  let hash = 0x73e2;
  for (let i = 0; i < base.length; i += 2) {
    hash ^= base.charCodeAt(i) << 8;
    if (i + 1 < base.length) hash ^= base.charCodeAt(i + 1);
  }
  return hash & 0x7fff;
}

function setWs(ws) { wsRef = ws; }

function getStatus() {
  return {
    connected: _connected,
    enabled: !!(currentConfig),
    server: currentConfig?.server,
    filterType: currentConfig?.filterType,
    filterStr: currentConfig?.filterStr || '',
  };
}

function broadcast(type, data) {
  if (wsRef) { try { wsRef.broadcast({ type, data }); } catch {} }
}

// Parse APRS DM notation (DDMM.mmN) to decimal degrees
function parseDM(dm, hemi) {
  const dot = dm.indexOf('.');
  if (dot < 2) return null;
  const deg = parseFloat(dm.slice(0, dot - 2));
  const min = parseFloat(dm.slice(dot - 2));
  if (isNaN(deg) || isNaN(min)) return null;
  let dd = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') dd = -dd;
  return dd;
}

// Parse uncompressed and timestamped APRS position bodies
function parsePosition(body) {
  // Uncompressed: [!=]DDMM.mmN[sym]DDDMM.mmE
  const plain = /[!=](\d{4}\.\d+)([NS])[\S](\d{5}\.\d+)([EW])/.exec(body);
  if (plain) {
    const lat = parseDM(plain[1], plain[2]);
    const lon = parseDM(plain[3], plain[4]);
    if (lat != null && lon != null) return { lat, lon };
  }
  // Timestamped: [/@]\d{6}[z/h]DDMM.mmN[sym]DDDMM.mmE
  const ts = /[@\/]\d{6}[zZhH\/](\d{4}\.\d+)([NS])[\S](\d{5}\.\d+)([EW])/.exec(body);
  if (ts) {
    const lat = parseDM(ts[1], ts[2]);
    const lon = parseDM(ts[3], ts[4]);
    if (lat != null && lon != null) return { lat, lon };
  }
  return null;
}

// Convert APRS A=XXXXXX altitude (feet per spec) to meters, with auto-detection
// for devices that incorrectly transmit in meters: if the raw value as meters is
// within 500 m of the node's last known GPS altitude, treat it as meters instead.
function inferAltitudeMeters(rawFt, nodeId) {
  const asMeters = rawFt * 0.3048;
  const valid = v => v >= -500 && v <= 8850; // surface to Everest summit
  if (!valid(asMeters)) {
    // Feet interpretation is physically impossible — try reading the raw value as meters
    return valid(rawFt) ? rawFt : null;
  }
  // Cross-check against last known GPS altitude for this node
  const reg = db.prepare('SELECT last_altitude FROM tracker_registry WHERE node_id=?').get(nodeId);
  if (reg?.last_altitude != null) {
    const errFt = Math.abs(asMeters - reg.last_altitude);
    const errM  = Math.abs(rawFt   - reg.last_altitude);
    if (errM < errFt && errM < 500) return rawFt; // raw value already in meters
  }
  return asMeters; // default: APRS spec (feet → meters)
}

// Parse APRS message body — body must start with ':' (message type indicator)
// Returns { addressee, text, seq } or null
function parseAprsMessage(body) {
  if (!body || body[0] !== ':') return null;
  const addrEnd = body.indexOf(':', 1);
  if (addrEnd < 0) return null;
  const addressee = body.slice(1, addrEnd).trim().toUpperCase();
  if (!addressee) return null;
  let text = body.slice(addrEnd + 1);
  let seq = null;
  const seqMatch = text.match(/\{([A-Za-z0-9]{1,5})\}?$/);
  if (seqMatch) { seq = seqMatch[1]; text = text.slice(0, seqMatch.index); }
  return { addressee, text: text.trim(), seq };
}

function sendAck(toCallsign, seq) {
  if (!socket || !_connected || !currentConfig) return;
  const from = currentConfig.callsign;
  const to   = toCallsign.toUpperCase().trim().padEnd(9, ' ');
  try {
    socket.write(`${from}>APRS,TCPIP*,qAC,${from}::${to}:ack${seq}\r\n`);
    logger.log('aprs', 'info', `ACK→${toCallsign.trim()} seq=${seq}`);
  } catch (e) {
    logger.log('aprs', 'error', `sendAck failed: ${e.message}`);
  }
}

function handleInboundMessage(fromCall, text) {
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return;
  const person = db.prepare(
    "SELECT * FROM personnel WHERE race_id=? AND UPPER(tracker_id)=? LIMIT 1"
  ).get(race.id, fromCall.toUpperCase());
  const ts = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, text, timestamp)
    VALUES (?,?,?,?,?,?,?)
  `).run(race.id, 'in', fromCall, person?.name || fromCall, currentConfig?.callsign || null, text, ts);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
  logger.log('aprs', 'info', `MSG from ${fromCall}${person ? ' (' + person.name + ')' : ''}: ${text}`);
  broadcast('message', msg);
}

function processLine(line) {
  if (!line) return;
  if (line.startsWith('#')) {
    // Skip periodic server heartbeat banners (# aprsc ...) — only log meaningful server responses
    if (/^# aprsc\b/.test(line)) return;
    logger.log('aprs', 'info', line);
    return;
  }

  const ci = line.indexOf(':');
  if (ci < 0) return;
  const header = line.slice(0, ci);
  const body   = line.slice(ci + 1);

  const gi = header.indexOf('>');
  if (gi < 0) return;
  const fromCall = header.slice(0, gi).toUpperCase().trim();
  if (!fromCall) return;

  // APRS message packet — check before position parsing
  const aprsMsg = parseAprsMessage(body);
  if (aprsMsg) {
    const myCall = currentConfig?.callsign?.toUpperCase();
    if (myCall && aprsMsg.addressee === myCall) {
      if (/^(ack|rej)\d+$/i.test(aprsMsg.text)) {
        logger.log('aprs', 'info', `${aprsMsg.text.slice(0, 3).toUpperCase()} from ${fromCall}: seq=${aprsMsg.text.slice(3)}`);
      } else {
        handleInboundMessage(fromCall, aprsMsg.text);
        if (aprsMsg.seq) sendAck(fromCall, aprsMsg.seq);
      }
    }
    return; // message packets never carry position data
  }

  const pos = parsePosition(body);
  if (!pos) return;

  // Altitude: APRS data extension A=XXXXXX (feet per spec)
  const altMatch = /\bA=(\d{1,6})\b/.exec(body);
  const altitude = altMatch ? inferAltitudeMeters(parseInt(altMatch[1]), fromCall) : null;

  // Battery voltage: patterns like 3.7V, 12.5V, 4.18V in the comment/status text
  const voltMatch = /\b(\d{1,2}\.\d{1,2})V\b/i.exec(body);
  const voltage = voltMatch ? parseFloat(voltMatch[1]) : null;

  logger.log('aprs', 'info',
    `position from ${fromCall} (${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)})` +
    (altitude != null ? ` alt=${Math.round(altitude)}m` : '') +
    (voltage  != null ? ` batt=${voltage}V` : ''));

  const ts = Math.floor(Date.now() / 1000);
  try {
    const mqttClient = require('./mqtt-client');
    mqttClient.handlePosition({
      nodeId: fromCall,
      lat: pos.lat,
      lon: pos.lon,
      altitude,
      speed: null,
      heading: null,
      battery: null,
      snr: null,
      rssi: null,
      timestamp: ts,
      rfSource: 'aprs',
    });
    if (voltage != null) {
      mqttClient.handleTelemetry({ nodeId: fromCall, battery: null, voltage, timestamp: ts });
    }
  } catch (e) {
    logger.log('aprs', 'error', `handlePosition: ${e.message}`);
  }
}

// ── Filter builders ───────────────────────────────────────────────────────────

function buildLocationFilter() {
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return '';

  let points = [];
  try {
    const fs = require('fs');
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const raw = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./routes/courses');
        const { trackPoints } = parseCourse(raw, course.file_path, course.path_index);
        if (trackPoints?.length) points = trackPoints;
      }
    }
    if (!points.length && race.track_file) {
      const raw = fs.readFileSync(race.track_file, 'utf8');
      const { parseTrack } = require('./routes/tracks');
      const tp = parseTrack(raw, race.track_file, race.track_path_index);
      if (tp?.length) points = tp;
    }
  } catch {}

  if (!points.length) {
    const stns = db.prepare('SELECT lat, lon FROM stations WHERE race_id=? AND lat IS NOT NULL AND lon IS NOT NULL').all(race.id);
    points = stns.map(s => [s.lat, s.lon]);
  }

  if (!points.length) return '';

  let sumLat = 0, sumLon = 0;
  for (const [lat, lon] of points) { sumLat += lat; sumLon += lon; }
  const cLat = sumLat / points.length;
  const cLon = sumLon / points.length;

  let maxDist = 0;
  for (const [lat, lon] of points) {
    const d = geo.haversine(cLat, cLon, lat, lon) / 1000; // km
    if (d > maxDist) maxDist = d;
  }
  const radius = Math.max(5, Math.ceil(maxDist * 1.5));

  return `r/${cLat.toFixed(4)}/${cLon.toFixed(4)}/${radius}`;
}

function buildCallsignFilter(raceId) {
  const race = raceId
    ? db.prepare('SELECT id FROM races WHERE id=?').get(raceId)
    : db.prepare("SELECT id FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return '';

  const calls = new Set();
  const addId = raw => {
    const id = (raw || '').trim().toUpperCase();
    if (APRS_CALL_RE.test(id)) calls.add(id);
  };

  db.prepare('SELECT tracker_id FROM participants WHERE race_id=? AND tracker_id IS NOT NULL').all(race.id)
    .forEach(p => addId(p.tracker_id));
  db.prepare('SELECT tracker_id FROM personnel WHERE race_id=? AND tracker_id IS NOT NULL').all(race.id)
    .forEach(p => addId(p.tracker_id));

  return calls.size ? 'b/' + [...calls].join('/') : '';
}

function buildFilter(filterType) {
  return filterType === 'location' ? buildLocationFilter() : buildCallsignFilter();
}

// ── Connection management ─────────────────────────────────────────────────────

function connect(config) {
  disconnect();
  currentConfig = { ...config };
  const filterStr = buildFilter(config.filterType);
  currentConfig.filterStr = filterStr;

  const loginLine = `user ${config.callsign} pass ${config.passcode} vers RaceTracker 1.0${filterStr ? ' filter ' + filterStr : ''}\r\n`;

  logger.log('aprs', 'info', `Connecting to ${config.server}:${config.port} as ${config.callsign}`);
  if (filterStr) logger.log('aprs', 'info', `Filter: ${filterStr}`);

  socket = new net.Socket();
  socket.setEncoding('utf8');
  socket.setTimeout(120000); // 2-min idle keepalive

  socket.connect(config.port, config.server, () => {
    _connected = true;
    socket.write(loginLine);
    logger.log('aprs', 'info', `Connected — login sent`);
    broadcast('aprs_status', getStatus());
  });

  socket.on('data', chunk => {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();
    for (const line of lines) processLine(line.trim());
  });

  socket.on('timeout', () => {
    logger.log('aprs', 'warn', 'Keepalive ping');
    try { socket.write('#keepalive\r\n'); } catch {}
  });

  socket.on('error', err => {
    _connected = false;
    logger.log('aprs', 'error', `Socket error: ${err.message}`);
    broadcast('aprs_status', { connected: false, error: err.message });
    scheduleReconnect();
  });

  socket.on('close', () => {
    _connected = false;
    logger.log('aprs', 'info', 'Socket closed');
    broadcast('aprs_status', { connected: false });
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (!currentConfig?.enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentConfig?.enabled) {
      logger.log('aprs', 'info', 'Reconnecting...');
      connect(currentConfig);
    }
  }, 15000);
}

function disconnect() {
  _connected = false;
  currentConfig = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) {
    socket.removeAllListeners(); // prevent stale close/error events firing on the new socket's context
    try { socket.destroy(); } catch {}
    socket = null;
  }
  lineBuffer = '';
}

function connectFromSettings(dbArg) {
  const _db = dbArg || db;
  const rows = _db.prepare("SELECT key, value FROM settings WHERE key LIKE 'aprs_%'").all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (s.aprs_enabled !== '1' || !s.aprs_callsign) return false;

  // Default: global callsign with configured or read-only passcode
  let callsign = s.aprs_callsign.toUpperCase().trim();
  let passcode = s.aprs_passcode || '-1';

  // If messaging is enabled and a user is logged in with a callsign, use it (allows sending)
  const activeRace = _db.prepare("SELECT messaging_enabled FROM races WHERE status='active' LIMIT 1").get();
  if (activeRace?.messaging_enabled && _messagingCallsign) {
    callsign = _messagingCallsign;
    passcode = String(generatePasscode(callsign));
    logger.log('aprs', 'info', `Using user callsign ${callsign} (passcode auto-computed) for messaging`);
  }

  connect({
    enabled: true,
    callsign,
    passcode,
    server: s.aprs_server || 'rotate.aprs2.net',
    port: parseInt(s.aprs_port) || 14580,
    filterType: s.aprs_filter_type || 'location',
  });
  return true;
}

// ── Outbound messaging ────────────────────────────────────────────────────────
let _msgSeq = 0;

function sendMessage(toCallsign, text) {
  if (!socket || !_connected) return false;
  _msgSeq = (_msgSeq % 999) + 1;
  const seq = String(_msgSeq).padStart(3, '0');
  const from = currentConfig.callsign;
  const to   = toCallsign.toUpperCase().trim().padEnd(9, ' ');
  const packet = `${from}>APRS,TCPIP*,qAC,${from}::${to}:${text}{${seq}}\r\n`;
  try {
    socket.write(packet);
    logger.log('aprs', 'info', `MSG→${toCallsign.trim()}: ${text}`);
    return seq;
  } catch (e) {
    logger.log('aprs', 'error', `sendMessage failed: ${e.message}`);
    return false;
  }
}

// Called after participants/personnel roster changes to refresh callsign filter live
function notifyRosterChange() {
  if (!socket || !_connected || !currentConfig) return;
  if (currentConfig.filterType !== 'callsign') return;
  const filterStr = buildCallsignFilter();
  currentConfig.filterStr = filterStr;
  if (filterStr) {
    logger.log('aprs', 'info', `Sending filter update: ${filterStr}`);
    try { socket.write(`#filter ${filterStr}\r\n`); } catch {}
  }
}

// Called on login/logout to set the callsign used for authenticated messaging
function setMessagingCallsign(callsign) {
  _messagingCallsign = callsign ? callsign.toUpperCase().trim() : null;
}

// Compute the preview filter string without connecting (for the admin UI)
function previewFilter(filterType) {
  return buildFilter(filterType);
}

module.exports = { connect, connectFromSettings, disconnect, getStatus, setWs, notifyRosterChange, previewFilter, sendMessage, generatePasscode, setMessagingCallsign };
