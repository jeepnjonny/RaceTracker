'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const mqttClient = require('../mqtt-client');
const aprsClient = require('../aprs-client');
const router = express.Router({ mergeParams: true });

const APRS_CALL_RE = /^[A-Z0-9]{1,6}(-(?:1[0-5]|[0-9]))?$/i;

router.get('/', requireAuth, (req, res) => {
  const { node_id, limit } = req.query;
  let sql = 'SELECT * FROM messages WHERE race_id=?';
  const args = [req.params.raceId];
  if (node_id) {
    sql += ' AND (from_node_id=? OR to_node_id=?)';
    args.push(node_id, node_id);
  }
  sql += ' ORDER BY timestamp DESC';
  if (limit) { sql += ' LIMIT ?'; args.push(parseInt(limit)); }
  res.json({ ok: true, data: db.prepare(sql).all(...args) });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { to_node_id, to_name, text } = req.body;
  if (!to_node_id || !text) return res.status(400).json({ ok: false, error: 'to_node_id and text required' });
  if (text.length > 67) return res.status(400).json({ ok: false, error: 'Message too long (max 67 chars)' });

  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const ts = Math.floor(Date.now() / 1000);
  const username = req.session?.user?.username || 'operator';

  let sent = false;
  let fromNodeId = null;

  if (APRS_CALL_RE.test(to_node_id.trim())) {
    const aprsRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'aprs_%'").all();
    const s = Object.fromEntries(aprsRows.map(r => [r.key, r.value]));
    fromNodeId = s.aprs_callsign || null;
    sent = aprsClient.sendMessage(to_node_id.trim(), text) !== false;
  } else {
    sent = mqttClient.publishMessage(to_node_id, text);
  }

  const result = db.prepare(`
    INSERT INTO messages (race_id, direction, from_node_id, from_name, to_node_id, to_name, text, timestamp)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(req.params.raceId, 'out', fromNodeId, username, to_node_id, to_name || null, text, ts);

  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
  wsManager.broadcast({ type: 'message', data: msg });
  res.json({ ok: true, data: { ...msg, sent } });
});

router.put('/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE messages SET read=1 WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  res.json({ ok: true });
});

module.exports = router;
