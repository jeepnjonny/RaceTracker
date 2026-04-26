'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'racetracker.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS course_files (
  id            INTEGER PRIMARY KEY,
  filename      TEXT NOT NULL,
  original_name TEXT NOT NULL,
  uploaded_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS races (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT NOT NULL,
  date                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending',
  course_file_id          INTEGER REFERENCES course_files(id),
  selected_path_index     INTEGER DEFAULT 0,
  geofence_radius_m       REAL    DEFAULT 20,
  off_course_distance_m   REAL    DEFAULT 50,
  off_course_alerts       INTEGER DEFAULT 0,
  off_course_msg_template TEXT    DEFAULT 'ALERT: {name} (#{bib}) is {dist}m off course.',
  off_course_send_mesh    INTEGER DEFAULT 0,
  off_course_send_aprs    INTEGER DEFAULT 0,
  missing_timer_min       INTEGER DEFAULT 30,
  time_format             TEXT    DEFAULT '12',
  viewer_hash             TEXT    UNIQUE,
  viewer_expires_at       INTEGER,
  mqtt_host               TEXT    DEFAULT 'apps.k7swi.org',
  mqtt_port               INTEGER DEFAULT 9001,
  mqtt_tls                INTEGER DEFAULT 0,
  mqtt_user               TEXT    DEFAULT '',
  mqtt_pass               TEXT    DEFAULT '',
  mqtt_region             TEXT    DEFAULT 'US',
  mqtt_channel            TEXT    DEFAULT 'RaceTracker',
  created_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS heats (
  id        INTEGER PRIMARY KEY,
  race_id   INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  start_time TEXT,
  icon_type TEXT    NOT NULL DEFAULT 'circle',
  color     TEXT    NOT NULL DEFAULT '#58a6ff'
);

CREATE TABLE IF NOT EXISTS classes (
  id      INTEGER PRIMARY KEY,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id           INTEGER PRIMARY KEY,
  race_id      INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL DEFAULT 'aid',
  lat          REAL    NOT NULL,
  lng          REAL    NOT NULL,
  course_pct   REAL,
  order_index  INTEGER DEFAULT 0,
  cutoff_time  TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id                INTEGER PRIMARY KEY,
  race_id           INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  bib               TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  tracker_id        TEXT,
  age               INTEGER,
  gender            TEXT,
  phone             TEXT,
  emergency_contact TEXT,
  emergency_phone   TEXT,
  heat_id           INTEGER REFERENCES heats(id),
  class_id          INTEGER REFERENCES classes(id),
  status            TEXT    NOT NULL DEFAULT 'pending',
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS position_log (
  id          INTEGER PRIMARY KEY,
  race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  tracker_id  TEXT    NOT NULL,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  altitude_m  REAL,
  speed_ms    REAL,
  battery_pct INTEGER,
  snr         REAL,
  rssi        INTEGER,
  rx_time     INTEGER NOT NULL,
  raw_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pos_race_tracker ON position_log(race_id, tracker_id);
CREATE INDEX IF NOT EXISTS idx_pos_rx_time      ON position_log(rx_time);

CREATE TABLE IF NOT EXISTS timing_events (
  id             INTEGER PRIMARY KEY,
  race_id        INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  participant_id INTEGER REFERENCES participants(id),
  station_id     INTEGER REFERENCES stations(id),
  event_type     TEXT    NOT NULL,
  event_time     INTEGER NOT NULL,
  auto_detected  INTEGER DEFAULT 0,
  entered_by     TEXT    DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_timing_race ON timing_events(race_id);

CREATE TABLE IF NOT EXISTS alerts (
  id             INTEGER PRIMARY KEY,
  race_id        INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  participant_id INTEGER REFERENCES participants(id),
  alert_type     TEXT    NOT NULL,
  triggered_at   INTEGER NOT NULL,
  resolved_at    INTEGER,
  details        TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer',
  created_at    INTEGER NOT NULL,
  active        INTEGER DEFAULT 1
);
`);

module.exports = db;
