'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const geo = require('../geo');
const { requireAuth, requireRole } = require('../auth');
const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'courses');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `course_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['.kml', '.gpx'].includes(path.extname(file.originalname).toLowerCase()));
  },
});

function parseKML(text) {
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

function extractGpxPt(inner, lat, lon) {
  const eleMatch = inner && inner.match(/<ele>([\d.+eE-]+)<\/ele>/);
  const pt = [parseFloat(lat), parseFloat(lon)];
  if (eleMatch) pt.push(parseFloat(eleMatch[1]));
  return pt;
}

function parseGPX(text) {
  const paths = [];
  // Track segments — capture inner content to extract <ele>
  const trkPoints = [];
  const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  let m;
  while ((m = trkptRe.exec(text)) !== null) {
    trkPoints.push(extractGpxPt(m[3], m[1], m[2]));
  }
  if (trkPoints.length >= 2) paths.push({ name: 'GPX Track', points: trkPoints });
  if (!paths.length) {
    const rteptRe = /<rtept\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/rtept>/gi;
    const rtePoints = [];
    while ((m = rteptRe.exec(text)) !== null) {
      rtePoints.push(extractGpxPt(m[3], m[1], m[2]));
    }
    if (rtePoints.length >= 2) paths.push({ name: 'GPX Route', points: rtePoints });
  }
  // Waypoints
  const points = [];
  const wptRe = /<wpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/wpt>/gi;
  while ((m = wptRe.exec(text)) !== null) {
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    const inner = m[3];
    const nameMatch = inner.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    const name = nameMatch ? nameMatch[1].trim() : `WP${points.length + 1}`;
    points.push({ name, lat, lon });
  }
  return { paths, points };
}

function parseCourse(text, filePath, pathIndex) {
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.gpx' ? parseGPX(text) : parseKML(text);
  const paths = parsed.paths || [];
  const idx = Math.min(pathIndex || 0, Math.max(0, paths.length - 1));
  return { paths, points: parsed.points || [], trackPoints: paths.length ? paths[idx].points : null };
}

router.get('/', requireAuth, (req, res) => {
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at DESC').all();
  res.json({ ok: true, data: courses });
});

router.post('/upload', requireRole('admin'), upload.single('course'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  const name = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const result = db.prepare(
    'INSERT INTO courses (name, file_path, file_type) VALUES (?,?,?)'
  ).run(name, req.file.path, ext);
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(result.lastInsertRowid);
  res.json({ ok: true, data: course });
});

router.get('/:id/parse', requireAuth, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return res.status(404).json({ ok: false, error: 'Course not found' });
  try {
    const text = fs.readFileSync(course.file_path, 'utf8');
    const { paths, points, trackPoints } = parseCourse(text, course.file_path, course.path_index);
    const meta = trackPoints ? geo.buildTrackMeta(trackPoints) : null;
    res.json({ ok: true, data: {
      paths: paths.map((p, i) => ({ index: i, name: p.name, pointCount: p.points.length })),
      points,
      trackPoints,
      totalDistance: meta?.total,
      pathIndex: course.path_index,
    }});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return res.status(404).json({ ok: false, error: 'Course not found' });
  const name = req.body.name ?? course.name;
  const path_index = req.body.path_index ?? course.path_index;
  db.prepare('UPDATE courses SET name=?, path_index=? WHERE id=?').run(name, path_index, req.params.id);
  res.json({ ok: true, data: db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return res.status(404).json({ ok: false, error: 'Course not found' });
  // Unlink from races
  db.prepare('UPDATE races SET course_id=NULL WHERE course_id=?').run(req.params.id);
  try { fs.unlinkSync(course.file_path); } catch {}
  db.prepare('DELETE FROM courses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.parseCourse = parseCourse;
module.exports.parseKML = parseKML;
module.exports.parseGPX = parseGPX;
