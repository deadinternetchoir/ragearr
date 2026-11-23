#!/usr/bin/env node
// Hourly auto-search and quality-upgrade selection, plus job priority.
// Uses a temp database; nothing is searched or downloaded (jobs are only queued).

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-auto-'));
process.env.RAGEARR_KNOWN_HOSTS = path.join(process.env.RAGEARR_DATA_DIR, 'known_hosts');

const db = require('../src/db');
const jobQueue = require('../src/services/jobQueue');
const autoSearch = require('../src/services/autoSearch');
const qualityProfiles = require('../src/services/qualityProfiles');
const settings = require('../src/services/settings');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Keep queued jobs queued: no handlers are registered and processNext is never awaited here.
const realSchedule = jobQueue.processNext;
db.prepare("INSERT INTO wanted_lists (name, source_type) VALUES ('t', 'csv')").run();
const add = (name, status, extra = {}) =>
  db
    .prepare(
      `INSERT INTO tracks (wanted_list_id, artist, track_name, status, monitored, quality_profile, matched_file_path, file_height, last_searched_at, upgrade_checked_at)
       VALUES (1, 'A', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, status, extra.monitored ?? 1, extra.profile || 'balanced_1080p', extra.path || null, extra.height ?? null, extra.searched || null, extra.checked || null).lastInsertRowid;

const pending = add('pending', 'pending');
const unmonitored = add('unmonitored', 'pending', { monitored: 0 });
const oldNoMatch = add('old no match', 'no_match', { searched: '2000-01-01 00:00:00' });
const freshNoMatch = add('fresh no match', 'no_match', { searched: new Date().toISOString().slice(0, 19).replace('T', ' ') });
const hasCandidate = add('has candidate', 'candidates_found');
const upgradeable = add('1080 file, 4K profile', 'imported', { profile: 'high_4k', path: 'A/A - x.mkv', height: 1080 });
const atCutoff = add('1080 file, 1080 profile', 'imported', { profile: 'balanced_1080p', path: 'A/A - y.mkv', height: 1080 });
const unknownHeight = add('unknown height', 'imported', { profile: 'high_4k', path: 'A/A - z.mkv' });
const checkedRecently = add('checked recently', 'imported', { profile: 'high_4k', path: 'A/A - w.mkv', height: 720, checked: new Date().toISOString().slice(0, 19).replace('T', ' ') });

assert(qualityProfiles.get('high_4k').cutoffHeight === 2160, 'Ultra-HD cutoffHeight is 2160');
assert(qualityProfiles.get('balanced_1080p').cutoffHeight === 1080, 'HD-1080p cutoffHeight is 1080');

const out = autoSearch.run();
const queued = (type) => db.prepare("SELECT ref_id FROM jobs WHERE type = ? AND status = 'queued'").all(type).map((r) => r.ref_id);
assert(out.searches === 1 && queued('track_search').includes(pending), 'new monitored track is searched');
assert(!queued('track_search').includes(unmonitored), 'unmonitored track is not searched');
assert(out.retries === 1 && queued('track_search').includes(oldNoMatch), 'old no-match is retried');
assert(!queued('track_search').includes(freshNoMatch), 'fresh no-match is left alone');
assert(!queued('track_search').includes(hasCandidate), 'track with a candidate is left alone');
const up = queued('track_upgrade');
assert(up.includes(upgradeable) && up.includes(unknownHeight), '1080p file under a 2160p profile (and unknown height) is checked for upgrade');
assert(!up.includes(atCutoff), 'file already at the profile cutoff is not checked');
assert(!up.includes(checkedRecently), 'recently checked file is not re-checked');

// Running again must not double-queue.
autoSearch.run();
assert(queued('track_search').length === 2 && queued('track_upgrade').length === 2, 'a second run does not duplicate queued jobs');

// Disabling upgrades stops upgrade checks.
db.prepare("DELETE FROM jobs").run();
settings.set('quality', { defaultProfileId: 'balanced_1080p', upgradesEnabled: false });
assert(autoSearch.run().upgrades === 0, 'upgrades can be switched off');
settings.set('quality', { defaultProfileId: 'balanced_1080p', upgradesEnabled: true });

// Priority: a download queued after many searches still runs first, upgrades last.
db.prepare("DELETE FROM jobs").run();
const ran = [];
for (const type of ['track_search', 'track_upgrade', 'track_download']) {
  jobQueue.registerHandler(type, async (job) => { ran.push(job.type); });
}
db.prepare("INSERT INTO jobs (type, ref_id, label, status) VALUES ('track_upgrade', 1, 'u', 'queued')").run();
db.prepare("INSERT INTO jobs (type, ref_id, label, status) VALUES ('track_search', 2, 's', 'queued')").run();
db.prepare("INSERT INTO jobs (type, ref_id, label, status) VALUES ('track_download', 3, 'd', 'queued')").run();
(async () => {
  for (let i = 0; i < 3; i++) await jobQueue.processNext();
  await new Promise((r) => setTimeout(r, 100));
  assert(ran.join(',') === 'track_download,track_search,track_upgrade', `job order was ${ran.join(',')}`);
  console.log('Auto-search tests OK');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
