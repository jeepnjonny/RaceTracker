'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const logger = require('../logger');
const router = express.Router({ mergeParams: true });

// GET /api/races/:raceId/rf-analysis
// Returns all position points for heatmap rendering, plus per-source summary.
// ?sources=meshtastic,aprs  (optional comma-separated filter)
router.get('/', requireAuth, (req, res) => {
  const raceId = req.params.raceId;
  const { sources } = req.query;

  let sql = `SELECT node_id, lat, lon, snr, rssi, rf_source, timestamp
             FROM tracker_positions
             WHERE race_id=? AND lat IS NOT NULL AND lon IS NOT NULL`;
  const args = [raceId];

  if (sources) {
    const srcList = sources.split(',').map(s => s.trim()).filter(Boolean);
    if (srcList.length) {
      sql += ` AND rf_source IN (${srcList.map(() => '?').join(',')})`;
      args.push(...srcList);
    }
  }

  const positions = db.prepare(sql + ' ORDER BY timestamp').all(...args);

  // Per-source summary (unfiltered — always show all available sources)
  const summaryRows = db.prepare(`
    SELECT COALESCE(rf_source,'meshtastic') as src,
           COUNT(*) as count,
           COUNT(DISTINCT node_id) as node_count,
           AVG(snr) as avg_snr, AVG(rssi) as avg_rssi,
           MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
    FROM tracker_positions
    WHERE race_id=? AND lat IS NOT NULL
    GROUP BY src
  `).all(raceId);

  const summary = {};
  for (const r of summaryRows) {
    summary[r.src] = {
      count: r.count,
      node_count: r.node_count,
      avg_snr:  r.avg_snr  != null ? Math.round(r.avg_snr  * 10) / 10 : null,
      avg_rssi: r.avg_rssi != null ? Math.round(r.avg_rssi)           : null,
      first_ts: r.first_ts,
      last_ts:  r.last_ts,
    };
  }

  res.json({ ok: true, data: { positions, summary } });
});

// GET /api/races/:raceId/rf-analysis/nodes
// Per-node breakdown with participant cross-reference
router.get('/nodes', requireAuth, (req, res) => {
  const raceId = req.params.raceId;
  const nodes = db.prepare(`
    SELECT tp.node_id,
           COALESCE(tp.rf_source,'meshtastic') as rf_source,
           COUNT(*) as packet_count,
           AVG(tp.snr)  as avg_snr,
           AVG(tp.rssi) as avg_rssi,
           MIN(tp.timestamp) as first_seen,
           MAX(tp.timestamp) as last_seen,
           tr.long_name, tr.short_name,
           p.bib, p.name as participant_name
    FROM tracker_positions tp
    LEFT JOIN tracker_registry tr ON tp.node_id = tr.node_id
    LEFT JOIN participants p ON p.race_id = tp.race_id AND (
      UPPER(p.tracker_id) = UPPER(tp.node_id) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.long_name,'')) OR
      UPPER(p.tracker_id) = UPPER(COALESCE(tr.short_name,''))
    )
    WHERE tp.race_id=? AND tp.lat IS NOT NULL
    GROUP BY tp.node_id, tp.rf_source
    ORDER BY packet_count DESC
  `).all(raceId);

  res.json({ ok: true, data: nodes });
});

// DELETE /api/races/:raceId/rf-analysis
// Purge all RF position data for this race (keeps participant/event records intact)
router.delete('/', requireRole('admin', 'operator'), (req, res) => {
  const raceId = req.params.raceId;
  const info = db.prepare('DELETE FROM tracker_positions WHERE race_id=?').run(raceId);
  logger.log('race', 'info', `RF data cleared for race ${raceId}: ${info.changes} records deleted by ${req.session.user.username}`);
  res.json({ ok: true, deleted: info.changes });
});

module.exports = router;
