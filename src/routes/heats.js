'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const heats = db.prepare('SELECT * FROM heats WHERE race_id=?').all(req.params.raceId);
  res.json({ ok: true, data: heats });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, color, shape, start_time } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const result = db.prepare('INSERT INTO heats (race_id, name, color, shape, start_time) VALUES (?,?,?,?,?)')
    .run(req.params.raceId, name, color || '#58a6ff', shape || 'circle', start_time || null);
  res.json({ ok: true, data: db.prepare('SELECT * FROM heats WHERE id=?').get(result.lastInsertRowid) });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, color, shape, start_time } = req.body;
  const heat = db.prepare('SELECT * FROM heats WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!heat) return res.status(404).json({ ok: false, error: 'Heat not found' });
  const newStartTime = start_time !== undefined ? (start_time || null) : heat.start_time;
  db.prepare('UPDATE heats SET name=?, color=?, shape=?, start_time=? WHERE id=?')
    .run(name ?? heat.name, color ?? heat.color, shape ?? heat.shape, newStartTime, req.params.id);

  // Propagate new start_time to tracker-less participants in this heat with no start_time set
  if (newStartTime && newStartTime !== heat.start_time) {
    db.prepare(`
      UPDATE participants SET start_time=?
      WHERE heat_id=? AND race_id=? AND (tracker_id IS NULL OR tracker_id='') AND (start_time IS NULL OR start_time=0)
    `).run(newStartTime, req.params.id, req.params.raceId);
    wsManager.broadcast({ type: 'participant_update', data: { action: 'bulk_update' } });
  }

  res.json({ ok: true, data: db.prepare('SELECT * FROM heats WHERE id=?').get(req.params.id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM heats WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Heat not found' });
  res.json({ ok: true });
});

module.exports = router;
