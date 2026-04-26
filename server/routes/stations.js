'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db');

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY order_index').all(req.params.id));
});

router.post('/', (req, res) => {
  const { name, type, lat, lng, course_pct, order_index, cutoff_time } = req.body;
  if (!name || lat == null || lng == null) return res.status(400).json({ error: 'name, lat, lng required' });
  const maxOrder = db.prepare('SELECT MAX(order_index) as m FROM stations WHERE race_id=?').get(req.params.id);
  const r = db.prepare(`
    INSERT INTO stations (race_id,name,type,lat,lng,course_pct,order_index,cutoff_time)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(req.params.id, name, type??'aid', lat, lng,
    course_pct??null, order_index??(( maxOrder.m ?? -1) + 1), cutoff_time??null);
  res.json(db.prepare('SELECT * FROM stations WHERE id=?').get(r.lastInsertRowid));
});

router.put('/:sid', (req, res) => {
  const fields = ['name','type','lat','lng','course_pct','order_index','cutoff_time'].filter(f => f in req.body);
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const set = fields.map(f=>`${f}=?`).join(',');
  db.prepare(`UPDATE stations SET ${set} WHERE id=? AND race_id=?`)
    .run(...fields.map(f=>req.body[f]), req.params.sid, req.params.id);
  res.json(db.prepare('SELECT * FROM stations WHERE id=?').get(req.params.sid));
});

router.delete('/:sid', (req, res) => {
  db.prepare('DELETE FROM stations WHERE id=? AND race_id=?').run(req.params.sid, req.params.id);
  res.json({ ok: true });
});

// Bulk reorder — body: [{id, order_index}]
router.put('/reorder', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'array required' });
  const upd = db.prepare('UPDATE stations SET order_index=? WHERE id=? AND race_id=?');
  db.transaction(() => { for (const { id, order_index } of req.body) upd.run(order_index, id, req.params.id); })();
  res.json({ ok: true });
});

module.exports = router;
