'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const wsManager = require('../websocket');
const logger = require('../logger');
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, (req, res) => {
  const { participant_id, station_id, limit } = req.query;
  let sql = `
    SELECT e.*, p.bib, p.name as participant_name, s.name as station_name
    FROM events e
    LEFT JOIN participants p ON e.participant_id = p.id
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.race_id=?
  `;
  const args = [req.params.raceId];
  if (participant_id) { sql += ' AND e.participant_id=?'; args.push(participant_id); }
  if (station_id) { sql += ' AND e.station_id=?'; args.push(station_id); }
  sql += ' ORDER BY e.timestamp DESC';
  if (limit) { sql += ' LIMIT ?'; args.push(parseInt(limit)); }

  const events = db.prepare(sql).all(...args);
  res.json({ ok: true, data: events });
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { participant_id, event_type, station_id, timestamp, notes } = req.body;
  if (!event_type) return res.status(400).json({ ok: false, error: 'event_type required' });

  const ts = timestamp || Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO events (race_id, participant_id, event_type, station_id, timestamp, notes, manual)
    VALUES (?,?,?,?,?,?,1)
  `).run(req.params.raceId, participant_id || null, event_type, station_id || null, ts, notes || null);

  // Update participant status for key events
  if (participant_id) {
    if (event_type === 'start') {
      db.prepare("UPDATE participants SET status='active', start_time=? WHERE id=? AND race_id=?")
        .run(ts, participant_id, req.params.raceId);
    } else if (event_type === 'finish') {
      db.prepare("UPDATE participants SET status='finished', finish_time=? WHERE id=? AND race_id=?")
        .run(ts, participant_id, req.params.raceId);
    } else if (event_type === 'dnf') {
      db.prepare("UPDATE participants SET status='dnf' WHERE id=? AND race_id=?")
        .run(participant_id, req.params.raceId);
    } else if (event_type === 'dns') {
      db.prepare("UPDATE participants SET status='dns' WHERE id=? AND race_id=?")
        .run(participant_id, req.params.raceId);
    }
  }

  const event = db.prepare(`
    SELECT e.*, p.bib, p.name as participant_name, s.name as station_name
    FROM events e
    LEFT JOIN participants p ON e.participant_id = p.id
    LEFT JOIN stations s ON e.station_id = s.id
    WHERE e.id=?
  `).get(result.lastInsertRowid);

  wsManager.broadcast({ type: 'event', data: event });
  const who = event.participant_name ? `#${event.bib} ${event.participant_name}` : '(no participant)';
  const where = event.station_name ? ` @ ${event.station_name}` : '';
  logger.log('race', 'info', `MANUAL ${event_type.toUpperCase()} — ${who}${where} by ${req.session.user.username}`);
  res.json({ ok: true, data: event });
});

router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id=? AND race_id=?').get(req.params.id, req.params.raceId);
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  const { event_type, station_id, timestamp, notes } = req.body;
  db.prepare('UPDATE events SET event_type=?, station_id=?, timestamp=?, notes=? WHERE id=?').run(
    event_type ?? event.event_type,
    station_id !== undefined ? station_id : event.station_id,
    timestamp ?? event.timestamp,
    notes !== undefined ? notes : event.notes,
    event.id
  );
  const updated = db.prepare('SELECT * FROM events WHERE id=?').get(event.id);
  wsManager.broadcast({ type: 'event', data: updated });
  res.json({ ok: true, data: updated });
});

router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM events WHERE id=? AND race_id=?').run(req.params.id, req.params.raceId);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'Event not found' });
  res.json({ ok: true });
});

module.exports = router;
