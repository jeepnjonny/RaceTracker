'use strict';
const express = require('express');
const https = require('https');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../auth');
const { parseTrack } = require('./tracks');
const router = express.Router({ mergeParams: true });

// Rejects on non-2xx so OWM 401/429 errors fall through to the v2.5 fallback
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = typeof url === 'string' ? { ...require('url').parse(url), headers } : url;
    https.get(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300)
            reject(new Error(json.message || json.title || `HTTP ${res.statusCode}`));
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

function getStationPoint(raceId) {
  const stn = db.prepare(
    "SELECT lat, lon FROM stations WHERE race_id=? AND type IN ('start','start_finish') LIMIT 1"
  ).get(raceId) || db.prepare(
    "SELECT lat, lon FROM stations WHERE race_id=? LIMIT 1"
  ).get(raceId);
  return stn ? { lat: stn.lat, lon: stn.lon } : null;
}

function resolveLocation(race) {
  return getTrackFirstPoint(race)
      || (race.weather_lat ? { lat: race.weather_lat, lon: race.weather_lon } : null)
      || getStationPoint(race.id);
}

function resolveKey() {
  return db.prepare("SELECT value FROM settings WHERE key='weather_api_key'").get()?.value || null;
}

router.get('/', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const apiKey = resolveKey();
  if (!apiKey) return res.status(400).json({ ok: false, error: 'No OpenWeather API key configured in Settings' });

  const pt = resolveLocation(race);
  if (!pt) return res.status(400).json({ ok: false, error: 'No location for this race — add a course, track file, or at least one station' });

  const { lat, lon } = pt;

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
    const data = await httpGet(url);
    return res.json({ ok: true, data });
  } catch {}

  try {
    const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily&appid=${apiKey}&units=imperial`;
    const data = await httpGet(url);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(502).json({ ok: false, error: `OpenWeather API error: ${e.message}` });
  }
});

// 24-hour forecast: OWM v2.5 free-tier, 3-hour intervals, cnt=8 = 24 h
router.get('/forecast', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const apiKey = resolveKey();
  if (!apiKey) return res.status(400).json({ ok: false, error: 'No OpenWeather API key configured in Settings' });

  const pt = resolveLocation(race);
  if (!pt) return res.status(400).json({ ok: false, error: 'No location for this race' });

  const { lat, lon } = pt;
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial&cnt=8`;
    const data = await httpGet(url);
    return res.json({ ok: true, data: data.list || [] });
  } catch (e) {
    return res.status(502).json({ ok: false, error: `OpenWeather API error: ${e.message}` });
  }
});

// Active weather alerts via NWS (US only, no API key required)
// NWS requires a descriptive User-Agent per their terms of service
const NWS_HEADERS = { 'User-Agent': 'RaceTracker/1.0 (race safety monitoring)', 'Accept': 'application/geo+json' };

const ALERT_SEVERITY = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

router.get('/alerts', requireAuth, async (req, res) => {
  const race = db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);
  if (!race) return res.status(404).json({ ok: false, error: 'Race not found' });

  const pt = resolveLocation(race);
  if (!pt) return res.status(400).json({ ok: false, error: 'No location for this race' });

  const { lat, lon } = pt;
  try {
    const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
    const data = await httpGet(url, NWS_HEADERS);
    const alerts = (data.features || [])
      .map(f => ({
        event:       f.properties.event,
        severity:    f.properties.severity,
        urgency:     f.properties.urgency,
        certainty:   f.properties.certainty,
        headline:    f.properties.headline,
        description: f.properties.description,
        effective:   f.properties.effective,
        expires:     f.properties.expires,
      }))
      .sort((a, b) => (ALERT_SEVERITY[b.severity] || 0) - (ALERT_SEVERITY[a.severity] || 0));
    return res.json({ ok: true, data: alerts });
  } catch (e) {
    // NWS only covers the US; return empty rather than an error so non-US races don't break
    return res.json({ ok: true, data: [], warning: e.message });
  }
});

module.exports = router;
