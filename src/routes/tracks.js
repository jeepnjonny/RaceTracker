'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const geo = require('../geo');
const { requireRole } = require('../auth');
const mqttClient = require('../mqtt-client');
const router = express.Router({ mergeParams: true });

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'tracks');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `race_${req.params.raceId}_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.kml', '.gpx'].includes(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

function parseKML(text) {
  const domParser = new (require('node:util').TextDecoder)();
  // Use regex-based parsing (no DOM in Node without extra deps)
  const paths = [];
  const points = [];
  const placemarkRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let pm;
  while ((pm = placemarkRe.exec(text)) !== null) {
    const block = pm[1];
    const nameMatch = block.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    const name = nameMatch ? nameMatch[1].trim() : 'Unnamed';
    const lsMatch = block.match(/<LineString[\s\S]*?<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i);
    if (lsMatch) {
      const pts = lsMatch[1].trim().split(/\s+/).map(c => {
        const p = c.split(',');
        return p.length >= 2 ? [parseFloat(p[1]), parseFloat(p[0])] : null;
      }).filter(p => p && !isNaN(p[0]) && !isNaN(p[1]));
      if (pts.length >= 2) paths.push({ name, points: pts });
    }
    const ptMatch = block.match(/<Point[\s\S]*?<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/i);
    if (ptMatch) {
      const parts = ptMatch[1].trim().split(',');
      if (parts.length >= 2) {
        points.push({ name, lat: parseFloat(parts[1]), lon: parseFloat(parts[0]) });
      }
    }
  }
  return { paths, points };
}

function parseGPX(text) {
  const trkPoints = [];
  const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/gi;
  let m;
  while ((m = trkptRe.exec(text)) !== null) {
    trkPoints.push([parseFloat(m[1]), parseFloat(m[2])]);
  }
  if (trkPoints.length >= 2) return [{ name: 'GPX Track', points: trkPoints }];
  const rteptRe = /<rtept\s+lat="([^"]+)"\s+lon="([^"]+)"/gi;
  const rtePoints = [];
  while ((m = rteptRe.exec(text)) !== null) {
    rtePoints.push([parseFloat(m[1]), parseFloat(m[2])]);
  }
  return rtePoints.length >= 2 ? [{ name: 'GPX Route', points: rtePoints }] : [];
}

function parseTrack(text, filePath, pathIndex) {
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.gpx' ? parseGPX(text) : parseKML(text).paths;
  if (!parsed || parsed.length === 0) return null;
  return (parsed[pathIndex] || parsed[0]).points;
}

router.get('/parse', requireRole('admin', 'operator'), (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race || !race.track_file) return res.json({ ok: true, data: null });
  try {
    const text = fs.readFileSync(race.track_file, 'utf8');
    const ext = path.extname(race.track_file).toLowerCase();
    const paths = ext === '.gpx' ? parseGPX(text) : parseKML(text).paths;
    const points = ext === '.gpx' ? [] : parseKML(text).points;
    const trackPoints = parseTrack(text, race.track_file, race.track_path_index);
    const meta = trackPoints ? geo.buildTrackMeta(trackPoints) : null;
    res.json({ ok: true, data: { paths, points, trackPoints, totalDistance: meta?.total, pathIndex: race.track_path_index } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/upload', requireRole('admin'), upload.single('track'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  // Delete old file
  if (race.track_file && fs.existsSync(race.track_file)) {
    try { fs.unlinkSync(race.track_file); } catch {}
  }

  const filePath = req.file.path;
  const text = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const paths = ext === '.gpx' ? parseGPX(text) : parseKML(text).paths;

  db.prepare('UPDATE races SET track_file=?, track_path_index=0 WHERE id=?').run(filePath, req.params.raceId);
  mqttClient.invalidateRouteCache(parseInt(req.params.raceId));

  res.json({ ok: true, data: {
    file: req.file.originalname,
    paths: paths.map((p, i) => ({ index: i, name: p.name, pointCount: p.points.length })),
  }});
});

router.put('/path-index', requireRole('admin'), (req, res) => {
  const { index } = req.body;
  db.prepare('UPDATE races SET track_path_index=? WHERE id=?').run(index ?? 0, req.params.raceId);
  mqttClient.invalidateRouteCache(parseInt(req.params.raceId));
  res.json({ ok: true });
});

module.exports = router;
module.exports.parseTrack = parseTrack;
