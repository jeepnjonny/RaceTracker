'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const db = require('./src/db');
const wsManager = require('./src/websocket');
const mqttClient = require('./src/mqtt-client');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'racetracker-secret-' + Math.random().toString(36);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }, // no maxAge = session cookie
});
app.use(sessionMiddleware);

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Viewer page (token-gated, no login) ──────────────────────────────────────
app.get('/view/:token', (req, res) => {
  const race = db.prepare('SELECT id FROM races WHERE viewer_token=?').get(req.params.token);
  if (!race) return res.status(404).send('Race not found or viewer link has been revoked.');
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',   require('./src/routes/auth'));
app.use('/api/users',  require('./src/routes/users'));
app.use('/api/races',  require('./src/routes/races'));

// Race-scoped routes
const raceRouter = express.Router({ mergeParams: true });
raceRouter.use('/tracks',       require('./src/routes/tracks'));
raceRouter.use('/stations',     require('./src/routes/stations'));
raceRouter.use('/participants', require('./src/routes/participants'));
raceRouter.use('/personnel',    require('./src/routes/personnel'));
raceRouter.use('/heats',        require('./src/routes/heats'));
raceRouter.use('/classes',      require('./src/routes/classes'));
raceRouter.use('/events',       require('./src/routes/events'));
raceRouter.use('/messages',     require('./src/routes/messages'));
raceRouter.use('/weather',      require('./src/routes/weather'));
app.use('/api/races/:raceId', raceRouter);

// ── MQTT test ─────────────────────────────────────────────────────────────────
app.post('/api/settings/mqtt-test', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const connected = mqttClient.connectFromSettings(db);
  if (!connected) return res.status(400).json({ ok: false, error: 'No MQTT host configured in settings' });
  // Give the client 2.5s to connect then report status
  setTimeout(() => {
    const status = mqttClient.getStatus();
    res.json({ ok: true, data: status });
  }, 2500);
});

// ── Global settings ───────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const data = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({ ok: true, data });
});

app.put('/api/settings', (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin')
    return res.status(403).json({ ok: false, error: 'Admin only' });
  const upsert = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(entries => { for (const [k, v] of entries) upsert.run(k, v ?? null); });
  tx(Object.entries(req.body));
  res.json({ ok: true });
});

// MQTT status & control
app.get('/api/mqtt/status', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  res.json({ ok: true, data: mqttClient.getStatus() });
});

// Tracker registry (infrastructure view)
app.get('/api/trackers', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const trackers = db.prepare('SELECT * FROM tracker_registry ORDER BY last_seen DESC').all();
  res.json({ ok: true, data: trackers });
});

// Latest positions for active race
app.get('/api/live', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const race = db.prepare("SELECT * FROM races WHERE status='active' LIMIT 1").get();
  if (!race) return res.json({ ok: true, data: [] });
  const positions = db.prepare(`
    SELECT tp.*, p.bib, p.name as participant_name, p.status as participant_status
    FROM tracker_positions tp
    JOIN (
      SELECT node_id, MAX(timestamp) as max_ts FROM tracker_positions WHERE race_id=? GROUP BY node_id
    ) latest ON tp.node_id = latest.node_id AND tp.timestamp = latest.max_ts
    LEFT JOIN participants p ON p.race_id=? AND (p.tracker_id = tp.node_id OR p.tracker_id IN (
      SELECT long_name FROM tracker_registry WHERE node_id = tp.node_id
    ))
    WHERE tp.race_id=?
  `).all(race.id, race.id, race.id);
  res.json({ ok: true, data: positions });
});

// ── SPA fallback — send index.html for unknown routes (except /api and /view) ─
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/view/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── HTTP server + WebSocket ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss = wsManager.init(server, sessionMiddleware);
mqttClient.setWs(wsManager);

// ── Auto-connect MQTT on startup if configured ────────────────────────────────
const connected = mqttClient.connectFromSettings(db);
if (connected) console.log('[server] MQTT connecting from global settings');
else console.log('[server] No MQTT settings configured yet');

server.listen(PORT, () => {
  console.log(`[server] RaceTracker listening on port ${PORT}`);
});
