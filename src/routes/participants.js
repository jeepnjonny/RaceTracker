'use strict';
const express = require('express');
const { parse: csvParse } = require('csv-parse/sync');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const router = express.Router({ mergeParams: true });

function enrichParticipant(p) {
  if (!p) return p;
  const heat = p.heat_id ? db.prepare('SELECT name, color, shape FROM heats WHERE id=?').get(p.heat_id) : null;
  const cls  = p.class_id ? db.prepare('SELECT name FROM classes WHERE id=?').get(p.class_id) : null;
  const reg  = p.tracker_id ? db.prepare(
    'SELECT last_lat, last_lon, battery_level, last_seen, snr, rssi FROM tracker_registry WHERE node_id=? OR long_name=? OR short_name=?'
  ).get(p.tracker_id, p.tracker_id, p.tracker_id) : null;
  return { ...p, heat, class: cls, tracker: reg };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM participants WHERE race_id=? ORDER BY bib').all(req.params.raceId);
  res.json({ ok: true, data: rows.map(enrichParticipant) });
});

router.get('/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!p) return res.status(404).json({ ok: false, error: 'Participant not found' });
  const events = db.prepare(`
    SELECT e.*, s.name as station_name FROM events e
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.participant_id=? ORDER BY e.timestamp
  `).all(p.id);
  res.json({ ok: true, data: { ...enrichParticipant(p), events } });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact } = req.body;
  if (!bib || !name) return res.status(400).json({ ok: false, error: 'bib and name required' });
  try {
    const result = db.prepare(`
      INSERT INTO participants (race_id, bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(req.params.raceId, String(bib), name, tracker_id || null, heat_id || null,
           class_id || null, age || null, phone || null, emergency_contact || null);
    const p = enrichParticipant(db.prepare('SELECT * FROM participants WHERE id=?').get(result.lastInsertRowid));
    wsManager.broadcast({ type: 'participant_update', data: { action: 'add', participant: p } });
    res.json({ ok: true, data: p });
  } catch (e) {
    res.status(409).json({ ok: false, error: 'Bib number already exists in this race' });
  }
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!p) return res.status(404).json({ ok: false, error: 'Participant not found' });

  const fields = ['bib','name','tracker_id','heat_id','class_id','age','phone','emergency_contact','status','start_time','finish_time'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f] === '' ? null : req.body[f];
  }
  if (!Object.keys(updates).length) return res.json({ ok: true, data: enrichParticipant(p) });

  const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE participants SET ${sets} WHERE id=?`).run(...Object.values(updates), p.id);
  const updated = enrichParticipant(db.prepare('SELECT * FROM participants WHERE id=?').get(p.id));
  wsManager.broadcast({ type: 'participant_update', data: { action: 'update', participant: updated } });
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM participants WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Participant not found' });
  wsManager.broadcast({ type: 'participant_update', data: { action: 'delete', id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// CSV import: bib, name, tracker_id, heat, class, age, phone, emergency_contact
router.post('/import', requireRole('admin', 'operator'), (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ ok: false, error: 'csv body required' });
  try {
    const rows = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    const raceId = req.params.raceId;
    const errors = [];

    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!row.bib || !row.name) { errors.push(`Row skipped: bib and name required`); continue; }

        // Resolve heat by name
        let heatId = null;
        if (row.heat) {
          const h = db.prepare('SELECT id FROM heats WHERE race_id=? AND name=?').get(raceId, row.heat.trim());
          if (h) heatId = h.id;
        }
        // Resolve class by name
        let classId = null;
        if (row.class) {
          const c = db.prepare('SELECT id FROM classes WHERE race_id=? AND name=?').get(raceId, row.class.trim());
          if (c) classId = c.id;
        }
        try {
          db.prepare(`
            INSERT INTO participants (race_id, bib, name, tracker_id, heat_id, class_id, age, phone, emergency_contact)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(race_id, bib) DO UPDATE SET
              name=excluded.name, tracker_id=excluded.tracker_id, heat_id=excluded.heat_id,
              class_id=excluded.class_id, age=excluded.age, phone=excluded.phone,
              emergency_contact=excluded.emergency_contact
          `).run(raceId, String(row.bib), row.name,
                 row.tracker_id || null, heatId, classId,
                 row.age ? parseInt(row.age) : null,
                 row.phone || null, row.emergency_contact || null);
        } catch (e) { errors.push(`Bib ${row.bib}: ${e.message}`); }
      }
    });
    tx();

    const participants = db.prepare('SELECT * FROM participants WHERE race_id=? ORDER BY bib').all(raceId);
    res.json({ ok: true, data: participants, errors });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
