'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const heats = db.prepare('SELECT * FROM heats WHERE race_id=?').all(req.params.raceId);
  res.json({ ok: true, data: heats });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, color, shape } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const result = db.prepare('INSERT INTO heats (race_id, name, color, shape) VALUES (?,?,?,?)')
    .run(req.params.raceId, name, color || '#58a6ff', shape || 'circle');
  res.json({ ok: true, data: { id: result.lastInsertRowid, race_id: req.params.raceId, name, color: color || '#58a6ff', shape: shape || 'circle' } });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, color, shape } = req.body;
  const heat = db.prepare('SELECT * FROM heats WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!heat) return res.status(404).json({ ok: false, error: 'Heat not found' });
  db.prepare('UPDATE heats SET name=?, color=?, shape=? WHERE id=?')
    .run(name ?? heat.name, color ?? heat.color, shape ?? heat.shape, req.params.id);
  res.json({ ok: true, data: { ...heat, name: name ?? heat.name, color: color ?? heat.color, shape: shape ?? heat.shape } });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM heats WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Heat not found' });
  res.json({ ok: true });
});

module.exports = router;
