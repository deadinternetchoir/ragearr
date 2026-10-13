#!/usr/bin/env node
// Restore edge cases: rows with differing columns, malformed settings,
// interrupted downloads, and atomicity when a backup is rejected part-way.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-backup-int-'));

const db = require('../src/db');
const backups = require('../src/services/backups');
const settings = require('../src/services/settings');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function throws(fn) {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  return null;
}

db.prepare("INSERT INTO wanted_lists (name, source_type) VALUES ('Original', 'manual')").run();
settings.set('quality', { defaultProfileId: 'balanced_1080p' });

// Rows in one table need not all carry the same keys; later rows must keep
// their extra columns rather than silently losing them.
const mixed = backups.createBackup(db);
mixed.tables.wanted_lists = [
  { id: 1, name: 'Plain' },
  { id: 2, name: 'Imported', source_type: 'csv_import' },
];
backups.restoreBackup(db, mixed);
const lists = db.prepare('SELECT id, name, source_type FROM wanted_lists ORDER BY id').all();
assert(lists.length === 2, 'both rows should restore');
assert(lists[0].source_type === 'manual', 'a row without the column gets the schema default');
assert(lists[1].source_type === 'csv_import', `second row lost its source_type: ${lists[1].source_type}`);

// A settings value that is not valid JSON would make settings.get() throw forever.
const badSettings = backups.createBackup(db);
badSettings.tables.settings = [{ key: 'library', value: '{not json' }];
const before = db.prepare('SELECT COUNT(*) AS n FROM wanted_lists').get().n;
const message = throws(() => backups.validateBackup(db, badSettings));
assert(message && /setting/i.test(message), `malformed settings value should be rejected, got ${message}`);
assert(throws(() => backups.restoreBackup(db, badSettings)), 'restore of malformed settings should fail');
assert(settings.get('quality') !== null, 'a rejected restore must leave existing settings alone');
assert(db.prepare('SELECT COUNT(*) AS n FROM wanted_lists').get().n === before, 'a rejected restore must leave data alone');

// A failure part-way through (here: a NOT NULL violation) rolls everything back.
const broken = backups.createBackup(db);
broken.tables.wanted_lists = [{ id: 9, name: 'Fine' }, { id: 10 }];
assert(throws(() => backups.restoreBackup(db, broken)), 'row violating NOT NULL should fail the restore');
assert(db.prepare('SELECT COUNT(*) AS n FROM wanted_lists').get().n === before, 'failed restore must roll back completely');
assert(settings.get('quality') !== null, 'failed restore must keep settings');

// Unknown columns are rejected rather than ignored.
const extra = backups.createBackup(db);
extra.tables.tracks = [{ id: 1, artist: 'A', track_name: 'T', not_a_column: 1 }];
assert(/unsupported column/.test(throws(() => backups.validateBackup(db, extra)) || ''), 'unknown column should be rejected');

// A backup taken mid-download must not restore a track stuck in 'downloading'
// (the restore also fails the job that would have finished it).
const mid = backups.createBackup(db);
mid.tables.tracks = [{ id: 1, artist: 'A', track_name: 'T', status: 'downloading' }];
mid.tables.jobs = [{ id: 1, type: 'track_download', ref_id: 1, label: 'A - T', status: 'running' }];
backups.restoreBackup(db, mid);
assert(db.prepare('SELECT status FROM jobs WHERE id = 1').get().status === 'failed', 'running job should be failed by restore');
assert(db.prepare('SELECT status FROM tracks WHERE id = 1').get().status === 'approved', 'downloading track should be released by restore');

db.close();
fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
console.log('Backup integrity tests OK');
