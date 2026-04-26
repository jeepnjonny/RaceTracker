'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const bridge  = require('../mqtt-bridge');
const crypto  = require('crypto');

function genHash() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

// List races
router.get('/', (req, res) => {
  const races = db.prepare('SELECT * FROM races ORDER BY date DESC, id DESC').all();
  res.json(races);
});

// Create race
router.post('/', (req, res) => {
  const { name, date } = req.body;
  if (!name || !date) return res.status(400).json({ error: 'name and date required' });
  const result = db.prepare(
    'INSERT INTO races (name, date, created_at) VALUES (?,?,?)'
  ).run(name, date, Date.now());
  res.json(db.prepare('SELECT * FROM races WHERE id=?').get(result.lastInsertRowid));
});

// Get race detail with stations, heats, classes
router.get('/:id', (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ error: 'not found' });
  race.stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY order_index').all(race.id);
  race.heats    = db.prepare('SELECT * FROM heats WHERE race_id=?').all(race.id);
  race.classes  = db.prepare('SELECT * FROM classes WHERE race_id=?').all(race.id);
  res.json(race);
});

// Update race settings
router.put('/:id', (req, res) => {
  const race = db.prepare('SELECT id FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ error: 'not found' });

  const allowed = [
    'name','date','course_file_id','selected_path_index',
    'geofence_radius_m','off_course_distance_m','off_course_alerts',
    'off_course_msg_template','off_course_send_mesh','off_course_send_aprs',
    'missing_timer_min','time_format',
    'mqtt_host','mqtt_port','mqtt_tls','mqtt_user','mqtt_pass','mqtt_region','mqtt_channel'
  ];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });

  const set = fields.map(f => `${f}=?`).join(',');
  const vals = fields.map(f => req.body[f]);
  db.prepare(`UPDATE races SET ${set} WHERE id=?`).run(...vals, req.params.id);

  // Invalidate route cache if course changed
  if (fields.includes('course_file_id') || fields.includes('selected_path_index')) {
    bridge.invalidateRouteCache(Number(req.params.id));
  }
  // Restart MQTT bridge if connection params changed
  const mqttFields = ['mqtt_host','mqtt_port','mqtt_tls','mqtt_user','mqtt_pass','mqtt_region','mqtt_channel'];
  if (fields.some(f => mqttFields.includes(f))) {
    const r = db.prepare("SELECT status FROM races WHERE id=?").get(req.params.id);
    if (r.status === 'active') bridge.restartBridge(Number(req.params.id));
  }

  res.json(db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id));
});

// Delete race
router.delete('/:id', (req, res) => {
  bridge.stopBridge(Number(req.params.id));
  db.prepare('DELETE FROM races WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Activate race — generate viewer hash, start MQTT bridge
router.post('/:id/activate', (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);
  if (!race) return res.status(404).json({ error: 'not found' });
  const hash = genHash() + genHash();
  db.prepare("UPDATE races SET status='active', viewer_hash=? WHERE id=?").run(hash, race.id);
  bridge.startBridge(race.id);
  res.json({ ok: true, viewer_hash: hash });
});

// Finish race
router.post('/:id/finish', (req, res) => {
  db.prepare("UPDATE races SET status='finished' WHERE id=?").run(req.params.id);
  bridge.stopBridge(Number(req.params.id));
  res.json({ ok: true });
});

// Update viewer expiry
router.put('/:id/viewer-expiry', (req, res) => {
  const { expires_at } = req.body; // unix ms or null
  db.prepare('UPDATE races SET viewer_expires_at=? WHERE id=?').run(expires_at ?? null, req.params.id);
  res.json({ ok: true });
});

// Invalidate viewer hash
router.delete('/:id/viewer', (req, res) => {
  db.prepare('UPDATE races SET viewer_hash=NULL, viewer_expires_at=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Heat CRUD
router.post('/:id/heats', (req, res) => {
  const { name, start_time, icon_type, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.prepare(
    'INSERT INTO heats (race_id,name,start_time,icon_type,color) VALUES (?,?,?,?,?)'
  ).run(req.params.id, name, start_time??null, icon_type??'circle', color??'#58a6ff');
  res.json(db.prepare('SELECT * FROM heats WHERE id=?').get(r.lastInsertRowid));
});
router.put('/:id/heats/:hid', (req, res) => {
  const fields = ['name','start_time','icon_type','color'].filter(f => f in req.body);
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const set = fields.map(f=>`${f}=?`).join(',');
  db.prepare(`UPDATE heats SET ${set} WHERE id=? AND race_id=?`).run(...fields.map(f=>req.body[f]), req.params.hid, req.params.id);
  res.json(db.prepare('SELECT * FROM heats WHERE id=?').get(req.params.hid));
});
router.delete('/:id/heats/:hid', (req, res) => {
  db.prepare('DELETE FROM heats WHERE id=? AND race_id=?').run(req.params.hid, req.params.id);
  res.json({ ok: true });
});

// Class CRUD
router.post('/:id/classes', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.prepare('INSERT INTO classes (race_id,name) VALUES (?,?)').run(req.params.id, name);
  res.json(db.prepare('SELECT * FROM classes WHERE id=?').get(r.lastInsertRowid));
});
router.put('/:id/classes/:cid', (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name required' });
  db.prepare('UPDATE classes SET name=? WHERE id=? AND race_id=?').run(req.body.name, req.params.cid, req.params.id);
  res.json(db.prepare('SELECT * FROM classes WHERE id=?').get(req.params.cid));
});
router.delete('/:id/classes/:cid', (req, res) => {
  db.prepare('DELETE FROM classes WHERE id=? AND race_id=?').run(req.params.cid, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
