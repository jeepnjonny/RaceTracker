'use strict';
const express = require('express');
const https = require('https');
const db = require('../db');
const { requireAuth } = require('../auth');
const router = express.Router({ mergeParams: true });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

// Current weather + alerts for the race location
router.get('/', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT weather_api_key, weather_lat, weather_lon FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });
  if (!race.weather_api_key) return res.status(400).json({ ok: false, error: 'No OpenWeather API key configured' });
  if (!race.weather_lat || !race.weather_lon) return res.status(400).json({ ok: false, error: 'Race location not configured' });

  try {
    const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${race.weather_lat}&lon=${race.weather_lon}&exclude=minutely,hourly,daily&appid=${race.weather_api_key}&units=imperial`;
    const data = await httpGet(url);
    res.json({ ok: true, data });
  } catch (e) {
    // Fallback to 2.5 API
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${race.weather_lat}&lon=${race.weather_lon}&appid=${race.weather_api_key}&units=imperial`;
      const data = await httpGet(url);
      res.json({ ok: true, data });
    } catch (e2) {
      res.status(500).json({ ok: false, error: e2.message });
    }
  }
});

module.exports = router;
