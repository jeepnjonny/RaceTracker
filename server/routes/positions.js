'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db');

// Latest position per tracker for this race
router.get('/latest', (req, res) => {
  const rows = db.prepare(`
    SELECT pl.tracker_id, pl.lat, pl.lng, pl.altitude_m, pl.speed_ms,
           pl.battery_pct, pl.snr, pl.rssi, pl.rx_time,
           p.id AS participant_id, p.bib, p.name, p.status,
           p.heat_id, h.icon_type AS heat_icon, h.color AS heat_color
    FROM (
      SELECT tracker_id, MAX(rx_time) AS max_time
      FROM position_log WHERE race_id=? GROUP BY tracker_id
    ) latest
    JOIN position_log pl ON pl.tracker_id=latest.tracker_id AND pl.rx_time=latest.max_time AND pl.race_id=?
    LEFT JOIN participants p ON p.race_id=? AND p.tracker_id=pl.tracker_id
    LEFT JOIN heats h ON h.id=p.heat_id
  `).all(req.params.id, req.params.id, req.params.id);
  res.json(rows);
});

// Full history for one tracker
router.get('/:tracker', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const rows  = db.prepare(`
    SELECT lat, lng, altitude_m, speed_ms, battery_pct, snr, rssi, rx_time
    FROM position_log WHERE race_id=? AND tracker_id=?
    ORDER BY rx_time DESC LIMIT ?
  `).all(req.params.id, req.params.tracker, limit);
  res.json(rows.reverse());
});

// Alerts for a race
router.get('/alerts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, p.bib, p.name AS participant_name
    FROM alerts a
    LEFT JOIN participants p ON p.id=a.participant_id
    WHERE a.race_id=? ORDER BY a.triggered_at DESC
  `).all(req.params.id);
  res.json(rows);
});

router.put('/alerts/:aid', (req, res) => {
  db.prepare('UPDATE alerts SET resolved_at=? WHERE id=? AND race_id=?')
    .run(Date.now(), req.params.aid, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
