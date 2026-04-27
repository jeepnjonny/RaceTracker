'use strict';
const express = require('express');
const https = require('https');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../auth');
const { parseTrack } = require('./tracks');
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

router.get('/', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get();
  const apiKey = apiKeyRow?.value;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'No OpenWeather API key configured in Settings' });

  const trackPt = getTrackFirstPoint(race);
  const lat = trackPt?.lat ?? race.weather_lat;
  const lon = trackPt?.lon ?? race.weather_lon;
  if (!lat || !lon) return res.status(400).json({ ok: false, error: 'No track or location configured for this race' });

  try {
    const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily&appid=${apiKey}&units=imperial`;
    const data = await httpGet(url);
    res.json({ ok: true, data });
  } catch {
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
      const data = await httpGet(url);
      res.json({ ok: true, data });
    } catch (e2) {
      res.status(500).json({ ok: false, error: e2.message });
    }
  }
});

module.exports = router;
