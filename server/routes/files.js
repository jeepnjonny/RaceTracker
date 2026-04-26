'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');

const TRACKS_DIR = path.join(__dirname, '..', '..', 'data', 'tracks');
if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: TRACKS_DIR,
  filename: (req, file, cb) => {
    const stamp = Date.now();
    const safe  = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${stamp}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(kml|gpx)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .kml and .gpx files are allowed'), ok);
  }
});

// List uploaded files
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM course_files ORDER BY uploaded_at DESC').all());
});

// Upload a file
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const result = db.prepare(
    'INSERT INTO course_files (filename, original_name, uploaded_at) VALUES (?,?,?)'
  ).run(req.file.filename, req.file.originalname, Date.now());
  res.json(db.prepare('SELECT * FROM course_files WHERE id=?').get(result.lastInsertRowid));
});

// Serve raw file content to browser (for KML/GPX parsing)
router.get('/:id/content', (req, res) => {
  const file = db.prepare('SELECT * FROM course_files WHERE id=?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'not found' });
  const fPath = path.join(TRACKS_DIR, file.filename);
  if (!fs.existsSync(fPath)) return res.status(404).json({ error: 'file missing on disk' });
  res.sendFile(fPath);
});

// Delete file (also nulls course_file_id on any race using it)
router.delete('/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM course_files WHERE id=?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'not found' });
  const fPath = path.join(TRACKS_DIR, file.filename);
  if (fs.existsSync(fPath)) fs.unlinkSync(fPath);
  db.prepare('UPDATE races SET course_file_id=NULL WHERE course_file_id=?').run(file.id);
  db.prepare('DELETE FROM course_files WHERE id=?').run(file.id);
  res.json({ ok: true });
});

module.exports = router;
