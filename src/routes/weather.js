'use strict';
const express = require('express');
const https = require('https');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../auth');
const { parseTrack } = require('./tracks');
const router = express.Router({ mergeParams: true });

// Rejects on non-2xx so OWM 401/429 errors fall through to the v2.5 fallback
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300)
            reject(new Error(json.message || `HTTP ${res.statusCode}`));
          else
            resolve(json);
        } catch (e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

function getTrackFirstPoint(race) {
  try {
    if (race.course_id) {
      const { parseCourse } = require('./courses');
      const course = db.prepare('SELECT * FROM courses WHERE id=?').get(race.course_id);
      if (course) {
        const text = fs.readFileSync(course.file_path, 'utf8');
        const { trackPoints } = parseCourse(text, course.file_path, course.path_index);
        if (trackPoints?.length) return { lat: trackPoints[0][0], lon: trackPoints[0][1] };
      }
    }
    if (!race.track_file) return null;
    const text = fs.readFileSync(race.track_file, 'utf8');
    const points = parseTrack(text, race.track_file, race.track_path_index || 0);
    return points?.length ? { lat: points[0][0], lon: points[0][1] } : null;
  } catch { return null; }
}

// Fallback: use the race start station (or any station) as the weather location
function getStationPoint(raceId) {
  const stn = db.prepare(
    "SELECT lat, lon FROM stations WHERE race_id=? AND type IN ('start','start_finish') LIMIT 1"
  ).get(raceId) || db.prepare(
    "SELECT lat, lon FROM stations WHERE race_id=? LIMIT 1"
  ).get(raceId);
  return stn ? { lat: stn.lat, lon: stn.lon } : null;
}

router.get('/', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get();
  const apiKey = apiKeyRow?.value;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'No OpenWeather API key configured in Settings' });

  const pt = getTrackFirstPoint(race)
          || (race.weather_lat ? { lat: race.weather_lat, lon: race.weather_lon } : null)
          || getStationPoint(race.id);
  if (!pt) return res.status(400).json({ ok: false, error: 'No location for this race — add a course, track file, or at least one station' });

  const { lat, lon } = pt;

  // Try v2.5 current weather first — works on all OWM free keys, no subscription needed
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
    const data = await httpGet(url);
    return res.json({ ok: true, data });
  } catch {}

  // Fallback: One Call 3.0 (requires paid OWM subscription)
  try {
    const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily&appid=${apiKey}&units=imperial`;
    const data = await httpGet(url);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(502).json({ ok: false, error: `OpenWeather API error: ${e.message}` });
  }
});

module.exports = router;
