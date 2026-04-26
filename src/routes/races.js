'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const mqttClient = require('../mqtt-client');
const router = express.Router();

const RACE_FIELDS = [
  'name','date','status','time_format','geofence_radius','off_course_distance',
  'stopped_time','missing_timer','alerts_enabled','messaging_enabled',
  'viewer_map_enabled','leaderboard_enabled','weather_enabled',
  'weather_api_key','weather_lat','weather_lon',
  'mqtt_host','mqtt_port_ws','mqtt_port_tcp','mqtt_user','mqtt_pass',
  'mqtt_region','mqtt_channel','mqtt_format','mqtt_psk',
];

router.get('/', requireAuth, (req, res) => {
  const races = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM participants WHERE race_id=r.id) as participant_count
    FROM races r ORDER BY r.date DESC
  `).all();
  res.json({ ok: true, data: races });
});

router.get('/active', requireAuth, (req, res) => {
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  res.json({ ok: true, data: race || null });
});

router.get('/:id', requireAuth, (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  res.json({ ok: true, data: race });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, date } = req.body;
  if (!name || !date) return res.status(400).json({ ok: false, error: 'name and date required' });
  const result = db.prepare('INSERT INTO races (name, date) VALUES (?,?)').run(name, date);
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(result.lastInsertRowid);
  res.json({ ok: true, data: race });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const updates = {};
  for (const f of RACE_FIELDS) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (Object.keys(updates).length === 0) return res.json({ ok: true, data: race });

  const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE races SET ${sets} WHERE id=?`).run(...Object.values(updates), req.params.id);

  // If MQTT settings changed and race is active, reconnect
  if (race.status === 'active') {
    const updated = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
    if (updated.status === 'active') reconnectMqtt(updated);
  }
  mqttClient.invalidateRouteCache(parseInt(req.params.id));

  res.json({ ok: true, data: db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  if (race.status === 'active') return res.status(400).json({ ok: false, error: 'Cannot delete active race. Set to past first.' });
  db.prepare('DELETE FROM races WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Activate a race (deactivates any current active race)
router.post('/:id/activate', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  db.prepare("UPDATE races SET status='past' WHERE status='active'").run();
  db.prepare("UPDATE races SET status='active' WHERE id=?").run(req.params.id);
  reconnectMqtt(db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id));
  res.json({ ok: true, data: { id: race.id, status: 'active' } });
});

router.post('/:id/deactivate', requireRole('admin'), (req, res) => {
  db.prepare("UPDATE races SET status='past' WHERE id=? AND status='active'").run(req.params.id);
  mqttClient.disconnect();
  res.json({ ok: true });
});

// Clone a race (copies settings, heats, classes, stations; NOT participants)
router.post('/:id/clone', requireRole('admin'), (req, res) => {
  const src = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ ok: false, error: 'Race not found' });

  const { name, date } = req.body;
  if (!name || !date) return res.status(400).json({ ok: false, error: 'name and date required for clone' });

  const newRace = db.prepare(`
    INSERT INTO races (name, date, status, time_format, geofence_radius, off_course_distance,
      stopped_time, missing_timer, alerts_enabled, messaging_enabled, viewer_map_enabled,
      leaderboard_enabled, weather_enabled, weather_api_key, weather_lat, weather_lon,
      mqtt_host, mqtt_port_ws, mqtt_port_tcp, mqtt_user, mqtt_pass,
      mqtt_region, mqtt_channel, mqtt_format, mqtt_psk, cloned_from)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(name, date, 'upcoming',
    src.time_format, src.geofence_radius, src.off_course_distance,
    src.stopped_time, src.missing_timer, src.alerts_enabled, src.messaging_enabled,
    src.viewer_map_enabled, src.leaderboard_enabled, src.weather_enabled,
    src.weather_api_key, src.weather_lat, src.weather_lon,
    src.mqtt_host, src.mqtt_port_ws, src.mqtt_port_tcp, src.mqtt_user, src.mqtt_pass,
    src.mqtt_region, src.mqtt_channel, src.mqtt_format, src.mqtt_psk, src.id);

  const newId = newRace.lastInsertRowid;

  // Clone heats (mapping old→new ids)
  const heatMap = {};
  for (const h of db.prepare('SELECT * FROM heats WHERE race_id=?').all(src.id)) {
    const r = db.prepare('INSERT INTO heats (race_id, name, color, shape) VALUES (?,?,?,?)').run(newId, h.name, h.color, h.shape);
    heatMap[h.id] = r.lastInsertRowid;
  }
  // Clone classes
  const classMap = {};
  for (const c of db.prepare('SELECT * FROM classes WHERE race_id=?').all(src.id)) {
    const r = db.prepare('INSERT INTO classes (race_id, name) VALUES (?,?)').run(newId, c.name);
    classMap[c.id] = r.lastInsertRowid;
  }
  // Clone stations
  for (const s of db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(src.id)) {
    db.prepare('INSERT INTO stations (race_id, name, lat, lon, type, cutoff_time, course_order) VALUES (?,?,?,?,?,?,?)')
      .run(newId, s.name, s.lat, s.lon, s.type, s.cutoff_time, s.course_order);
  }
  // Clone personnel (without tracker IDs)
  for (const p of db.prepare('SELECT * FROM personnel WHERE race_id=?').all(src.id)) {
    db.prepare('INSERT INTO personnel (race_id, name, phone) VALUES (?,?,?)').run(newId, p.name, p.phone);
  }

  res.json({ ok: true, data: db.prepare('SELECT * FROM races WHERE id=?').get(newId) });
});

// Generate viewer token
router.post('/:id/viewer-token', requireRole('admin'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  const token = crypto.createHash('sha256')
    .update(`${race.name}-${race.date}-${Date.now()}`).digest('hex').substring(0, 16);
  db.prepare('UPDATE races SET viewer_token=? WHERE id=?').run(token, req.params.id);
  res.json({ ok: true, data: { token } });
});

router.delete('/:id/viewer-token', requireRole('admin'), (req, res) => {
  db.prepare('UPDATE races SET viewer_token=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

function reconnectMqtt(race) {
  mqttClient.connect({
    host: race.mqtt_host,
    portWs: race.mqtt_port_ws,
    user: race.mqtt_user,
    pass: race.mqtt_pass,
    region: race.mqtt_region,
    channel: race.mqtt_channel,
    format: race.mqtt_format,
    psk: race.mqtt_psk,
  });
}

module.exports = router;
