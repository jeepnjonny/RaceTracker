'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const logger = require('../logger');
const aprsClient = require('../aprs-client');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ ok: false, error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user) {
    logger.log('system', 'warn', `Login failed — unknown user "${username}"`);
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    logger.log('system', 'warn', `Login failed — invalid password for "${username}"`);
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }

  req.session.user = { id: user.id, username: user.username, role: user.role, callsign: user.callsign || null };
  logger.log('system', 'info', `Login — ${user.username} (${user.role})${user.callsign ? ' callsign=' + user.callsign : ''}`);
  aprsClient.setMessagingCallsign(user.callsign || null);
  aprsClient.connectFromSettings(db);
  res.json({ ok: true, data: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', (req, res) => {
  const who = req.session?.user?.username;
  req.session.destroy(() => {
    if (who) logger.log('system', 'info', `Logout — ${who}`);
    aprsClient.setMessagingCallsign(null);
    aprsClient.connectFromSettings(db);
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  res.json({ ok: true, data: req.session.user });
});

module.exports = router;
