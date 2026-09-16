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
    thumbnail_url TEXT,            -- YouTube thumbnail or generated local frame thumbnail
    monitored INTEGER NOT NULL DEFAULT 1,
    quality_profile TEXT NOT NULL DEFAULT 'balanced_1080p',
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

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "Concerts" feature: artist-level full concert/live-show acquisition via
-- Prowlarr. Deliberately separate from tracks/candidates above — indexer
-- "Music Video" categories are populated with full concert releases, not
-- individual song clips, so this is a distinct browse-and-grab flow rather
-- than part of the per-track review queue. See docs/prowlarr-notes.md.
CREATE TABLE IF NOT EXISTS concert_grabs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist TEXT NOT NULL,
  release_title TEXT NOT NULL,
  indexer_id INTEGER,
  indexer_name TEXT,
  guid TEXT,                     -- Prowlarr release GUID, used to fetch the download link
  status TEXT NOT NULL DEFAULT 'grabbed', -- grabbed | downloading | downloaded | imported | failed
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_candidates_track ON candidates(track_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// tracks.matched_file_path: set by a library scan (services/library.js) when
// a real file is found on disk matching this track - distinct from a
// candidate's url (a YouTube video Ragearr itself found/downloaded).
// ALTER TABLE ADD COLUMN, not part of the CREATE TABLE above, since this
// column was added after tracks already existed on deployed instances -
// CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so a
// new column needs its own idempotent migration.
const trackColumns = db.prepare("PRAGMA table_info(tracks)").all().map((c) => c.name);
if (!trackColumns.includes('matched_file_path')) {
  db.exec('ALTER TABLE tracks ADD COLUMN matched_file_path TEXT');
}
if (!trackColumns.includes('monitored')) {
  db.exec('ALTER TABLE tracks ADD COLUMN monitored INTEGER NOT NULL DEFAULT 1');
}
if (!trackColumns.includes('quality_profile')) {
  db.exec("ALTER TABLE tracks ADD COLUMN quality_profile TEXT NOT NULL DEFAULT 'balanced_1080p'");
}
if (!trackColumns.includes('thumbnail_url')) {
  db.exec('ALTER TABLE tracks ADD COLUMN thumbnail_url TEXT');
}
if (!trackColumns.includes('root_folder_id')) {
  db.exec('ALTER TABLE tracks ADD COLUMN root_folder_id TEXT');
}
db.exec(`
UPDATE tracks
SET thumbnail_url = (
  SELECT 'https://i.ytimg.com/vi/' || c.external_id || '/hqdefault.jpg'
  FROM candidates c
  WHERE c.track_id = tracks.id
    AND c.source = 'youtube'
  ORDER BY c.selected DESC, c.score DESC
  LIMIT 1
)
WHERE thumbnail_url IS NULL
  AND EXISTS (
    SELECT 1 FROM candidates c
    WHERE c.track_id = tracks.id
      AND c.source = 'youtube'
  );
`);

// concert_grabs.matched_path: same idea as tracks.matched_file_path, set by
// the Concerts library scan (services/library.js scanConcerts).
const grabColumns = db.prepare("PRAGMA table_info(concert_grabs)").all().map((c) => c.name);
if (!grabColumns.includes('matched_path')) {
  db.exec('ALTER TABLE concert_grabs ADD COLUMN matched_path TEXT');
}
if (!grabColumns.includes('root_folder_id')) {
  db.exec('ALTER TABLE concert_grabs ADD COLUMN root_folder_id TEXT');
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_concert_grabs_artist ON concert_grabs(artist);

-- Real background job queue (services/jobQueue.js) - replaces the earlier
-- model where a download blocked the HTTP request for its full duration.
-- Every *arr app has a queue/activity view backed by something like this;
-- Ragearr never did, which is exactly the gap that made it not feel like
-- a real member of the family.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,             -- track_download | concert_grab
  ref_id INTEGER NOT NULL,        -- tracks.id | concert_grabs.id
  label TEXT NOT NULL,            -- human-readable, e.g. "Artist - Track"
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  message TEXT,                   -- progress note or error text
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);

module.exports = db;
