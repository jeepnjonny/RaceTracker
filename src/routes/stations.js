'use strict';
const express = require('express');
const { parse: csvParse } = require('csv-parse/sync');
const fs = require('fs');
const db = require('../db');
const geo = require('../geo');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const router = express.Router({ mergeParams: true });

function getTrackPoints(raceId) {
  const race = db.prepare('SELECT track_file, track_path_index FROM races WHERE id=?').get(raceId);
  if (!race || !race.track_file) return null;
  try {
    const raw = fs.readFileSync(race.track_file, 'utf8');
    const { parseTrack } = require('./tracks');
    return parseTrack(raw, race.track_file, race.track_path_index);
  } catch { return null; }
}

function reorderStations(raceId) {
  const stations = db.prepare('SELECT * FROM stations WHERE race_id=?').all(raceId);
  const points = getTrackPoints(raceId);
  if (!points || stations.length === 0) return;
  const ordered = geo.orderStationsByRoute(stations, points);
  const upd = db.prepare('UPDATE stations SET course_order=? WHERE id=?');
  const tx = db.transaction(() => { for (const s of ordered) upd.run(s.course_order, s.id); });
  tx();
}

router.get('/', requireAuth, (req, res) => {
  const stations = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM personnel WHERE station_id=s.id) as personnel_count
    FROM stations s WHERE s.race_id=? ORDER BY s.course_order, s.id
  `).all(req.params.raceId);
  res.json({ ok: true, data: stations });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, lat, lon, type, cutoff_time } = req.body;
  if (!name || lat === undefined || lon === undefined)
    return res.status(400).json({ ok: false, error: 'name, lat, lon required' });
  const result = db.prepare(
    'INSERT INTO stations (race_id, name, lat, lon, type, cutoff_time) VALUES (?,?,?,?,?,?)'
  ).run(req.params.raceId, name, lat, lon, type || 'aid', cutoff_time || null);
  reorderStations(req.params.raceId);
  const station = db.prepare('SELECT * FROM stations WHERE id=?').get(result.lastInsertRowid);
  wsManager.broadcast({ type: 'station_update', data: { action: 'add', station } });
  res.json({ ok: true, data: station });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const s = db.prepare('SELECT * FROM stations WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!s) return res.status(404).json({ ok: false, error: 'Station not found' });
  const { name, lat, lon, type, cutoff_time } = req.body;
  db.prepare('UPDATE stations SET name=?, lat=?, lon=?, type=?, cutoff_time=? WHERE id=?').run(
    name ?? s.name, lat ?? s.lat, lon ?? s.lon, type ?? s.type, cutoff_time ?? s.cutoff_time, s.id
  );
  reorderStations(req.params.raceId);
  const updated = db.prepare('SELECT * FROM stations WHERE id=?').get(s.id);
  wsManager.broadcast({ type: 'station_update', data: { action: 'update', station: updated } });
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM stations WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Station not found' });
  wsManager.broadcast({ type: 'station_update', data: { action: 'delete', id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// CSV import: name, lat, lon, type, cutoff_time
router.post('/import', requireRole('admin', 'operator'), (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ ok: false, error: 'csv body required' });
  try {
    const rows = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    const insert = db.prepare(
      'INSERT OR REPLACE INTO stations (race_id, name, lat, lon, type, cutoff_time) VALUES (?,?,?,?,?,?)'
    );
    const tx = db.transaction(() => {
      for (const row of rows) {
        insert.run(req.params.raceId, row.name, parseFloat(row.lat), parseFloat(row.lon),
                   row.type || 'aid', row.cutoff_time || null);
      }
    });
    tx();
    reorderStations(req.params.raceId);
    const stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(req.params.raceId);
    res.json({ ok: true, data: stations });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
