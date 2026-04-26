'use strict';
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK(role IN ('admin','operator')),
  created_at    INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS races (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  date                TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'upcoming'
                               CHECK(status IN ('upcoming','active','past')),
  track_file          TEXT,
  track_path_index    INTEGER DEFAULT 0,
  viewer_token        TEXT    UNIQUE,
  time_format         TEXT    DEFAULT '12h' CHECK(time_format IN ('12h','24h')),
  geofence_radius     INTEGER DEFAULT 15,
  off_course_distance INTEGER DEFAULT 100,
  stopped_time        INTEGER DEFAULT 600,
  missing_timer       INTEGER DEFAULT 3600,
  alerts_enabled      INTEGER DEFAULT 1,
  messaging_enabled   INTEGER DEFAULT 0,
  viewer_map_enabled  INTEGER DEFAULT 1,
  leaderboard_enabled INTEGER DEFAULT 1,
  weather_enabled     INTEGER DEFAULT 0,
  weather_api_key     TEXT,
  weather_lat         REAL,
  weather_lon         REAL,
  mqtt_host           TEXT    DEFAULT 'apps.k7swi.org',
  mqtt_port_ws        INTEGER DEFAULT 9001,
  mqtt_port_tcp       INTEGER DEFAULT 1883,
  mqtt_user           TEXT    DEFAULT 'racetracker',
  mqtt_pass           TEXT    DEFAULT 'racetracker',
  mqtt_region         TEXT    DEFAULT 'US',
  mqtt_channel        TEXT    DEFAULT 'RaceTracker',
  mqtt_format         TEXT    DEFAULT 'json' CHECK(mqtt_format IN ('json','proto')),
  mqtt_psk            TEXT    DEFAULT 'AQ==',
  cloned_from         INTEGER REFERENCES races(id),
  created_at          INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS heats (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id  INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  color    TEXT    NOT NULL DEFAULT '#58a6ff',
  shape    TEXT    NOT NULL DEFAULT 'circle'
           CHECK(shape IN ('circle','triangle','square','diamond','star','pentagon'))
);

CREATE TABLE IF NOT EXISTS classes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  lat           REAL    NOT NULL,
  lon           REAL    NOT NULL,
  type          TEXT    NOT NULL DEFAULT 'aid'
                CHECK(type IN ('start','finish','aid','checkpoint')),
  cutoff_time   TEXT,
  course_order  INTEGER DEFAULT 0,
  created_at    INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS personnel (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  station_id  INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  name        TEXT    NOT NULL,
  tracker_id  TEXT,
  phone       TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS participants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id           INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  bib               TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  tracker_id        TEXT,
  heat_id           INTEGER REFERENCES heats(id) ON DELETE SET NULL,
  class_id          INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  age               INTEGER,
  phone             TEXT,
  emergency_contact TEXT,
  status            TEXT    DEFAULT 'dns'
                    CHECK(status IN ('dns','active','dnf','finished')),
  start_time        INTEGER,
  finish_time       INTEGER,
  created_at        INTEGER DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_bib ON participants(race_id, bib);

CREATE TABLE IF NOT EXISTS tracker_registry (
  node_id       TEXT    PRIMARY KEY,
  long_name     TEXT,
  short_name    TEXT,
  hw_model      INTEGER,
  battery_level INTEGER,
  voltage       REAL,
  last_seen     INTEGER,
  last_lat      REAL,
  last_lon      REAL,
  last_altitude REAL,
  last_speed    REAL,
  snr           REAL,
  rssi          INTEGER
);

CREATE TABLE IF NOT EXISTS tracker_positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id      INTEGER REFERENCES races(id),
  node_id      TEXT    NOT NULL,
  lat          REAL    NOT NULL,
  lon          REAL    NOT NULL,
  altitude     REAL,
  speed        REAL,
  heading      REAL,
  battery      INTEGER,
  snr          REAL,
  rssi         INTEGER,
  timestamp    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_node ON tracker_positions(node_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id        INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  event_type     TEXT    NOT NULL
                 CHECK(event_type IN
                   ('start','aid_arrive','aid_depart','finish',
                    'dnf','dns','off_course','stopped','manual')),
  station_id     INTEGER REFERENCES stations(id),
  timestamp      INTEGER NOT NULL,
  notes          TEXT,
  manual         INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_race ON events(race_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id      INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  direction    TEXT    NOT NULL CHECK(direction IN ('in','out')),
  from_node_id TEXT,
  to_node_id   TEXT,
  from_name    TEXT,
  to_name      TEXT,
  text         TEXT    NOT NULL,
  timestamp    INTEGER NOT NULL,
  read         INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_race ON messages(race_id, timestamp DESC);
`);

// Seed default admin on first run
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync('admin', 10);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')")
    .run(hash);
  console.log('[db] Created default admin user: admin / admin  — change this password!');
}

module.exports = db;
