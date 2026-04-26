'use strict';
const express = require('express');
const { parse: csvParse } = require('csv-parse/sync');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const personnel = db.prepare(`
    SELECT p.*, s.name as station_name FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id
    WHERE p.race_id=? ORDER BY s.course_order, p.name
  `).all(req.params.raceId);
  res.json({ ok: true, data: personnel });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, station_id, tracker_id, phone } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const result = db.prepare(
    'INSERT INTO personnel (race_id, station_id, name, tracker_id, phone) VALUES (?,?,?,?,?)'
  ).run(req.params.raceId, station_id || null, name, tracker_id || null, phone || null);
  const person = db.prepare(`
    SELECT p.*, s.name as station_name FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id WHERE p.id=?
  `).get(result.lastInsertRowid);
  res.json({ ok: true, data: person });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const p = db.prepare('SELECT * FROM personnel WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!p) return res.status(404).json({ ok: false, error: 'Personnel not found' });
  const { name, station_id, tracker_id, phone } = req.body;
  db.prepare('UPDATE personnel SET name=?, station_id=?, tracker_id=?, phone=? WHERE id=?')
    .run(name ?? p.name, station_id !== undefined ? station_id : p.station_id,
         tracker_id !== undefined ? tracker_id : p.tracker_id,
         phone !== undefined ? phone : p.phone, p.id);
  const updated = db.prepare(`
    SELECT p.*, s.name as station_name FROM personnel p
    LEFT JOIN stations s ON p.station_id = s.id WHERE p.id=?
  `).get(p.id);
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM personnel WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Personnel not found' });
  res.json({ ok: true });
});

// CSV import: name, station_name, tracker_id, phone
router.post('/import', requireRole('admin', 'operator'), (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ ok: false, error: 'csv body required' });
  try {
    const rows = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    const raceId = req.params.raceId;
    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!row.name) continue;
        let stationId = null;
        if (row.station_name) {
          const s = db.prepare('SELECT id FROM stations WHERE race_id=? AND name=?').get(raceId, row.station_name.trim());
          if (s) stationId = s.id;
        }
        db.prepare('INSERT INTO personnel (race_id, station_id, name, tracker_id, phone) VALUES (?,?,?,?,?)')
          .run(raceId, stationId, row.name, row.tracker_id || null, row.phone || null);
      }
    });
    tx();
    const personnel = db.prepare('SELECT * FROM personnel WHERE race_id=? ORDER BY name').all(raceId);
    res.json({ ok: true, data: personnel });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
