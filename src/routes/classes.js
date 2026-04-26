'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const classes = db.prepare('SELECT * FROM classes WHERE race_id=?').all(req.params.raceId);
  res.json({ ok: true, data: classes });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const result = db.prepare('INSERT INTO classes (race_id, name) VALUES (?,?)').run(req.params.raceId, name);
  res.json({ ok: true, data: { id: result.lastInsertRowid, race_id: req.params.raceId, name } });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name } = req.body;
  const cls = db.prepare('SELECT * FROM classes WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!cls) return res.status(404).json({ ok: false, error: 'Class not found' });
  db.prepare('UPDATE classes SET name=? WHERE id=?').run(name ?? cls.name, req.params.id);
  res.json({ ok: true, data: { ...cls, name: name ?? cls.name } });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM classes WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Class not found' });
  res.json({ ok: true });
});

module.exports = router;
