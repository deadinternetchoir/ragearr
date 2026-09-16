#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-backups-'));

const db = require('../src/db');
const settings = require('../src/services/settings');
const backups = require('../src/services/backups');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

settings.set('library', { musicVideoRootFolders: [{ id: 'root-a', name: 'Main', path: '/media/MusicVideos' }] });
const listId = db.prepare("INSERT INTO wanted_lists (name, source_type) VALUES ('Backup List', 'manual')").run().lastInsertRowid;
const trackId = db
  .prepare(
    `INSERT INTO tracks (wanted_list_id, artist, track_name, status, matched_file_path, root_folder_id)
     VALUES (?, 'Backup Artist', 'Backup Track', 'imported', 'Backup Artist/Backup Artist - Backup Track.mkv', 'root-a')`
  )
  .run(listId).lastInsertRowid;
db.prepare(
  `INSERT INTO candidates (track_id, source, external_id, title, origin, url, tier, score, selected)
   VALUES (?, 'youtube', 'abc123', 'Backup Artist - Backup Track', 'Official', 'https://youtube.test/watch?v=abc123', 'high', 99, 1)`
).run(trackId);
db.prepare(
  `INSERT INTO jobs (type, ref_id, label, status, message)
   VALUES ('track_download', ?, 'Backup Artist - Backup Track', 'running', 'in progress')`
).run(trackId);

const backup = backups.createBackup(db);
assert(backup.app === 'ragearr', 'backup app marker missing');
assert(backup.counts.tracks === 1, 'backup should contain one track');
assert(backups.validateBackup(db, backup).summary.counts.candidates === 1, 'preview should count candidates');

db.prepare('DELETE FROM candidates').run();
db.prepare('DELETE FROM tracks').run();
db.prepare('DELETE FROM wanted_lists').run();
db.prepare('DELETE FROM settings').run();
assert(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n === 0, 'test setup should clear tracks before restore');

const restored = backups.restoreBackup(db, backup);
assert(restored.ok, 'restore should return ok');
assert(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n === 1, 'restore should reinsert tracks');
assert(db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n === 1, 'restore should reinsert candidates');
assert(db.prepare('SELECT value FROM settings WHERE key = ?').get('library'), 'restore should reinsert settings');
assert(db.prepare('SELECT status FROM jobs').get().status === 'failed', 'running jobs should be marked failed on restore');

let failed = false;
try {
  backups.validateBackup(db, { app: 'not-ragearr', version: 1, tables: {} });
} catch (e) {
  failed = /Ragearr/.test(e.message);
}
assert(failed, 'invalid app backups should fail validation');

db.close();
fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
console.log('Backup tests OK');
