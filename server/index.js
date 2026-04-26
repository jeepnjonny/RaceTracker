'use strict';
const express = require('express');
const path    = require('path');
const db      = require('./db');
const bridge  = require('./mqtt-bridge');

const app  = express();
const PORT = process.env.PORT || 3000;

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── SSE Hub ──────────────────────────────────────────────────────────────────
// Map of race_id -> Set of SSE response objects
const sseClients = new Map();

function sseAdd(raceId, res) {
  if (!sseClients.has(raceId)) sseClients.set(raceId, new Set());
  sseClients.get(raceId).add(res);
}
function sseRemove(raceId, res) {
  sseClients.get(raceId)?.delete(res);
}
function broadcast(raceId, data) {
  const clients = sseClients.get(raceId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { sseRemove(raceId, res); }
  }
}

bridge.setBroadcast(broadcast);

// SSE endpoint
app.get('/RaceTracker/api/events/:raceId', (req, res) => {
  const raceId = Number(req.params.raceId);
  const race   = db.prepare('SELECT id FROM races WHERE id=?').get(raceId);
  if (!race) return res.status(404).end();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  sseAdd(raceId, res);
  // Send a heartbeat every 25 s to keep the connection alive through proxies
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 25000);

  req.on('close', () => { clearInterval(hb); sseRemove(raceId, res); });
});

// ── API Routes ───────────────────────────────────────────────────────────────
const BASE = '/RaceTracker/api';

app.use(`${BASE}/races`,                                   require('./routes/races'));
app.use(`${BASE}/races/:id/participants`,                  require('./routes/participants'));
app.use(`${BASE}/races/:id/stations`,                      require('./routes/stations'));
app.use(`${BASE}/races/:id/timing`,                        require('./routes/timing'));
app.use(`${BASE}/races/:id/positions`,                     require('./routes/positions'));
app.use(`${BASE}/files`,                                   require('./routes/files'));

// ── Viewer route ─────────────────────────────────────────────────────────────
app.get('/RaceTracker/viewer/:hash', (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE viewer_hash=?').get(req.params.hash);
  if (!race) return res.status(404).send('Race not found or link has expired.');
  if (race.viewer_expires_at && Date.now() > race.viewer_expires_at) {
    return res.status(410).send('This race link has expired.');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'viewer.html'));
});

// Viewer data API (no auth needed — public, scoped to hash)
app.get(`${BASE}/viewer/:hash`, (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE viewer_hash=?').get(req.params.hash);
  if (!race) return res.status(404).json({ error: 'not found' });
  if (race.viewer_expires_at && Date.now() > race.viewer_expires_at) {
    return res.status(410).json({ error: 'expired' });
  }
  race.stations     = db.prepare('SELECT * FROM stations WHERE race_id=? ORDER BY order_index').all(race.id);
  race.heats        = db.prepare('SELECT * FROM heats WHERE race_id=?').all(race.id);
  race.classes      = db.prepare('SELECT * FROM classes WHERE race_id=?').all(race.id);
  race.participants = db.prepare('SELECT * FROM participants WHERE race_id=?').all(race.id);
  // Latest positions
  race.positions = db.prepare(`
    SELECT pl.tracker_id, pl.lat, pl.lng, pl.rx_time,
           p.bib, p.name, p.status, p.heat_id
    FROM (SELECT tracker_id, MAX(rx_time) AS max_time FROM position_log WHERE race_id=? GROUP BY tracker_id) latest
    JOIN position_log pl ON pl.tracker_id=latest.tracker_id AND pl.rx_time=latest.max_time AND pl.race_id=?
    LEFT JOIN participants p ON p.race_id=? AND p.tracker_id=pl.tracker_id
  `).all(race.id, race.id, race.id);
  res.json(race);
});

// ── Static files ─────────────────────────────────────────────────────────────
app.use('/RaceTracker', express.static(path.join(__dirname, '..', 'public')));

// Root redirect
app.get('/RaceTracker', (req, res) => res.redirect('/RaceTracker/operator.html'));
app.get('/RaceTracker/', (req, res) => res.redirect('/RaceTracker/operator.html'));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RaceTracker server running on port ${PORT}`);
  bridge.resumeActiveBridges();
});
