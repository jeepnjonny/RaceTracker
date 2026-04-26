'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const multer  = require('multer');
const db      = require('../db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const FIELDS = ['bib','name','tracker_id','age','gender','phone',
                'emergency_contact','emergency_phone','heat_id','class_id','status','notes'];

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      h.name  AS heat_name,  h.icon_type AS heat_icon,  h.color AS heat_color,
      c.name  AS class_name,
      (SELECT lat      FROM position_log WHERE race_id=p.race_id AND tracker_id=p.tracker_id ORDER BY rx_time DESC LIMIT 1) AS last_lat,
      (SELECT lng      FROM position_log WHERE race_id=p.race_id AND tracker_id=p.tracker_id ORDER BY rx_time DESC LIMIT 1) AS last_lng,
      (SELECT rx_time  FROM position_log WHERE race_id=p.race_id AND tracker_id=p.tracker_id ORDER BY rx_time DESC LIMIT 1) AS last_seen,
      (SELECT battery_pct FROM position_log WHERE race_id=p.race_id AND tracker_id=p.tracker_id ORDER BY rx_time DESC LIMIT 1) AS battery_pct
    FROM participants p
    LEFT JOIN heats   h ON h.id = p.heat_id
    LEFT JOIN classes c ON c.id = p.class_id
    WHERE p.race_id=?
    ORDER BY CAST(p.bib AS INTEGER), p.bib
  `).all(req.params.id);
  res.json(rows);
});

router.get('/:pid', (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id=? AND race_id=?').get(req.params.pid, req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  p.timing = db.prepare(`
    SELECT te.*, s.name AS station_name, s.type AS station_type
    FROM timing_events te
    LEFT JOIN stations s ON s.id = te.station_id
    WHERE te.participant_id=? ORDER BY te.event_time ASC
  `).all(p.id);
  p.alerts = db.prepare("SELECT * FROM alerts WHERE participant_id=? ORDER BY triggered_at DESC").all(p.id);
  res.json(p);
});

router.post('/', (req, res) => {
  if (!req.body.bib || !req.body.name) return res.status(400).json({ error: 'bib and name required' });
  const vals = FIELDS.map(f => req.body[f] ?? null);
  const r = db.prepare(
    `INSERT INTO participants (race_id,${FIELDS.join(',')}) VALUES (?${',?'.repeat(FIELDS.length)})`
  ).run(req.params.id, ...vals);
  res.json(db.prepare('SELECT * FROM participants WHERE id=?').get(r.lastInsertRowid));
});

router.put('/:pid', (req, res) => {
  const fields = FIELDS.filter(f => f in req.body);
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const set = fields.map(f=>`${f}=?`).join(',');
  db.prepare(`UPDATE participants SET ${set} WHERE id=? AND race_id=?`)
    .run(...fields.map(f=>req.body[f]), req.params.pid, req.params.id);
  res.json(db.prepare('SELECT * FROM participants WHERE id=?').get(req.params.pid));
});

router.delete('/:pid', (req, res) => {
  db.prepare('DELETE FROM participants WHERE id=? AND race_id=?').run(req.params.pid, req.params.id);
  res.json({ ok: true });
});

// CSV import: columns bib,name,tracker_id,age,gender,phone,emergency_contact,emergency_phone,heat,class
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const lines = req.file.buffer.toString('utf8').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'empty CSV' });

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const raceId  = req.params.id;
  let imported = 0, skipped = 0;

  const insertP = db.prepare(
    `INSERT OR IGNORE INTO participants (race_id,bib,name,tracker_id,age,gender,phone,emergency_contact,emergency_phone)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const get  = key => { const idx = headers.indexOf(key); return idx >= 0 ? cols[idx] || null : null; };
      const bib  = get('bib');
      const name = get('name');
      if (!bib || !name) { skipped++; continue; }
      insertP.run(raceId, bib, name, get('tracker_id'), get('age'), get('gender'),
                  get('phone'), get('emergency_contact'), get('emergency_phone'));
      imported++;
    }
  })();

  res.json({ imported, skipped });
});

module.exports = router;
