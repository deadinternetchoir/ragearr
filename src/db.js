const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.RAGEARR_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'ragearr.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS wanted_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual', -- manual | csv_import
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wanted_list_id INTEGER REFERENCES wanted_lists(id) ON DELETE CASCADE,
  artist TEXT NOT NULL,
  track_name TEXT NOT NULL,
  album TEXT,
  duration_sec REAL,
  source_uri TEXT,               -- e.g. spotify:track:...
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending | searching | candidates_found | approved | downloading
    -- | downloaded | imported | rejected | no_match
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source TEXT NOT NULL,          -- prowlarr | youtube
  external_id TEXT NOT NULL,     -- indexer release GUID | YouTube video id
  title TEXT,
  origin TEXT,                   -- indexer name | YouTube channel name
  url TEXT,
  tier TEXT,                     -- high | medium | none  (see services/youtube.js scoring)
  score REAL,
  metadata_json TEXT,            -- raw candidate payload for debugging/review
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_candidates_track ON candidates(track_id);
`);

module.exports = db;
