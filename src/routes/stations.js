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
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(raceId);
  if (!race) return null;
  // Prefer global course library
  if (race.course_id) {
    try {
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const raw = fs.readFileSync(course.file_path, 'utf8');
        const { parseCourse } = require('./courses');
        const parsed = parseCourse(raw, course.file_path, course.path_index);
        return parsed.trackPoints || null;
      }
    } catch {}
  }
  if (!race.track_file) return null;
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
  const s = db.prepare('SELECT id FROM stations WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!s) return res.status(404).json({ ok: false, error: 'Station not found' });
  db.prepare('UPDATE events SET station_id=NULL WHERE station_id=?').run(req.params.id);
  db.prepare('DELETE FROM stations WHERE id=?').run(req.params.id);
  wsManager.broadcast({ type: 'station_update', data: { action: 'delete', id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// Seed stations from course waypoints
router.post('/seed', requireRole('admin'), (req, res) => {
  const { waypoints } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length === 0)
    return res.status(400).json({ ok: false, error: 'waypoints array required' });
  const insert = db.prepare(
    'INSERT INTO stations (race_id, name, lat, lon, type) VALUES (?,?,?,?,?)'
  );
  const tx = db.transaction(() => {
    for (const w of waypoints) {
      insert.run(req.params.raceId, w.name, parseFloat(w.lat), parseFloat(w.lon), w.type || 'aid');
    }
  });
  tx();
  reorderStations(req.params.raceId);
  const stations = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY course_order').all(req.params.raceId);
  res.json({ ok: true, data: stations });
});

// Import stations from a CSV file stored in the csv_files library
router.post('/import-from-lib', requireRole('admin'), (req, res) => {
  const { csv_file_id } = req.body;
  if (!csv_file_id) return res.status(400).json({ ok: false, error: 'csv_file_id required' });
  const csvFile = db.prepare('SELECT * FROM csv_files WHERE id=?').get(csv_file_id);
  if (!csvFile) return res.status(404).json({ ok: false, error: 'CSV file not found' });
  try {
    const csv = fs.readFileSync(csvFile.file_path, 'utf8');
    const rows = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true });
    const insert = db.prepare(
      'INSERT INTO stations (race_id, name, lat, lon, type, cutoff_time) VALUES (?,?,?,?,?,?)'
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
