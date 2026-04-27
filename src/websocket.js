'use strict';
const WebSocket = require('ws');
const db = require('./db');

let wss = null;
const clients = new Set();

function init(server, sessionMiddleware) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Authenticate via session cookie
    sessionMiddleware(req, {}, () => {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token');
      let user = req.session?.user || null;

      // Viewer auth via race token
      if (!user && token) {
        const race = db.prepare('SELECT id, name FROM races WHERE viewer_token=?').get(token);
        if (race) {
          user = { role: 'viewer', raceId: race.id };
        }
      }

      if (!user) {
        ws.close(4401, 'Unauthorized');
        return;
      }

      ws.user = user;
      clients.add(ws);

      // Send initial state
      sendInit(ws, user);

      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });

  return wss;
}

function getTrackPointsForRace(race) {
  const fs = require('fs');
  try {
    if (race.course_id) {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./routes/courses');
        const { trackPoints } = parseCourse(text, course.file_path, course.path_index);
        if (trackPoints?.length) return trackPoints;
      }
    }
    if (race.track_file) {
      const text = fs.readFileSync(race.track_file, 'utf8');
      const { parseTrack } = require('./routes/tracks');
      return parseTrack(text, race.track_file, race.track_path_index) || null;
    }
  } catch {}
  return null;
}

function sendInit(ws, user) {
  try {
    const activeRace = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
    if (!activeRace) {
      send(ws, 'init', { race: null });
      return;
    }

    const raceId = user.role === 'viewer' ? user.raceId : activeRace.id;
    const race = user.role === 'viewer'
      ? db.prepare('SELECT * FROM races WHERE id=?').get(raceId)
      : activeRace;

    const participants = db.prepare(`
      SELECT p.*, h.name as heat_name, h.color as heat_color, h.shape as heat_shape,
             c.name as class_name,
             tr.last_lat, tr.last_lon, tr.battery_level, tr.last_seen
      FROM participants p
      LEFT JOIN heats h ON p.heat_id = h.id
      LEFT JOIN classes c ON p.class_id = c.id
      LEFT JOIN tracker_registry tr ON p.tracker_id = tr.node_id
         OR p.tracker_id = tr.long_name OR p.tracker_id = tr.short_name
      WHERE p.race_id=?
    `).all(raceId);

    const stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(raceId);
    const heats = db.prepare('SELECT * FROM heats WHERE race_id=?').all(raceId);
    const classes = db.prepare('SELECT * FROM classes WHERE race_id=?').all(raceId);
    const registry = db.prepare('SELECT * FROM tracker_registry').all();
    const mqttMod = require('./mqtt-client');
    const trackPoints = getTrackPointsForRace(race);

    send(ws, 'init', {
      race,
      participants,
      stations,
      heats,
      classes,
      registry,
      trackPoints,
      mqtt: mqttMod.getStatus(),
    });
  } catch (e) {
    console.error('[ws] sendInit error:', e.message);
  }
}

function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(str);
    }
  }
}

function broadcastToRole(roles, msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && roles.includes(ws.user?.role)) {
      ws.send(str);
    }
  }
}

module.exports = { init, broadcast, broadcastToRole, send };
