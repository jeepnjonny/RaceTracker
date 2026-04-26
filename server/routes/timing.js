'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db');

router.get('/', (req, res) => {
  const events = db.prepare(`
    SELECT te.*,
      p.bib AS bib, p.name AS participant_name,
      s.name AS station_name, s.type AS station_type
    FROM timing_events te
    LEFT JOIN participants p ON p.id = te.participant_id
    LEFT JOIN stations     s ON s.id = te.station_id
    WHERE te.race_id=?
    ORDER BY te.event_time ASC
  `).all(req.params.id);
  res.json(events);
});

router.post('/', (req, res) => {
  const { participant_id, station_id, event_type, event_time, entered_by } = req.body;
  if (!event_type || !event_time) return res.status(400).json({ error: 'event_type and event_time required' });
  const r = db.prepare(`
    INSERT INTO timing_events (race_id, participant_id, station_id, event_type, event_time, auto_detected, entered_by)
    VALUES (?,?,?,?,?,0,?)
  `).run(req.params.id, participant_id??null, station_id??null, event_type,
    event_time, entered_by??'operator');

  // Auto-update participant status based on event type
  if (participant_id) {
    const statusMap = { dns: 'dns', dnf: 'dnf', finish: 'finished', start: 'active' };
    if (statusMap[event_type]) {
      db.prepare('UPDATE participants SET status=? WHERE id=?').run(statusMap[event_type], participant_id);
    }
  }

  res.json(db.prepare('SELECT * FROM timing_events WHERE id=?').get(r.lastInsertRowid));
});

router.put('/:eid', (req, res) => {
  const fields = ['participant_id','station_id','event_type','event_time','entered_by'].filter(f => f in req.body);
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const set = fields.map(f=>`${f}=?`).join(',');
  db.prepare(`UPDATE timing_events SET ${set} WHERE id=? AND race_id=?`)
    .run(...fields.map(f=>req.body[f]), req.params.eid, req.params.id);
  res.json(db.prepare('SELECT * FROM timing_events WHERE id=?').get(req.params.eid));
});

router.delete('/:eid', (req, res) => {
  db.prepare('DELETE FROM timing_events WHERE id=? AND race_id=?').run(req.params.eid, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
