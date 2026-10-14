#!/usr/bin/env node
// Follow-ups from docs/review-2026-10.md decisions D2, D3, D4, D7 and D13.
// Temp database; no network or yt-dlp needed.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-followups-'));
process.env.YTDLP_PATH = path.join(process.env.RAGEARR_DATA_DIR, 'no-such-yt-dlp');

const db = require('../src/db');
const importLists = require('../src/services/importLists');
const youtube = require('../src/services/youtube');
const backups = require('../src/services/backups');
const users = require('../src/services/users');
const jobQueue = require('../src/services/jobQueue');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  // D2: loopback and link-local are refused; LAN ranges and public addresses are not blocked.
  for (const addr of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert(importLists.isBlockedAddress(addr), `${addr} should be blocked`);
  }
  for (const addr of ['192.168.1.138', '10.0.0.5', '172.16.0.1', '8.8.8.8', '2001:db8::1']) {
    assert(!importLists.isBlockedAddress(addr), `${addr} should be allowed`);
  }
  for (const url of ['http://127.0.0.1:1/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://localhost/x']) {
    const msg = await importLists.fetchText(url).then(() => null, (e) => e.message);
    assert(/loopback or link-local/.test(msg), `${url} should be refused, got: ${msg}`);
  }

  // D3: built-in exclusions ignore words that belong to the artist or track name.
  const ex = (title, artist, trackName) => youtube.isExcluded(title, {}, { artist, trackName });
  assert(!ex('Oasis - Live Forever (Official Video)', 'Oasis', 'Live Forever'), 'track named "Live Forever" is not a live recording');
  assert(!ex('Chicago - If You Leave Me Now (Official Video)', 'Chicago', 'If You Leave Me Now'), 'artist named after a city is kept');
  assert(!ex('Boston - More Than a Feeling (Official Video)', 'Boston', 'More Than a Feeling'), 'Boston is kept');
  assert(!ex('Paramore - Cover Me Up (Official Video)', 'Paramore', 'Cover Me Up'), 'track named "Cover Me" is kept');
  assert(ex('Oasis - Live Forever (Live at Knebworth)', 'Oasis', 'Live Forever'), 'a real live recording is still excluded');
  assert(ex('Chicago - If You Leave Me Now (Live in Chicago)', 'Chicago', 'If You Leave Me Now'), 'a live suffix is still excluded');
  assert(ex('Band - Song [Official Audio]', 'Band', 'Song'), 'other exclusions still apply');
  assert(ex('Band - Song (Official Video)', 'Band', 'Song') === false, 'plain official video is kept');
  assert(youtube.isExcluded('Band - Song (Official Video)', { excludedPhrases: ['official video'] }, { artist: 'Band', trackName: 'Song' }), 'custom phrases use the full title');
  assert(youtube.isExcluded('Band - Song live'), 'still works with no artist or track context');
  const ranked = youtube.rankOfficialMv(
    [{ id: 'a', title: 'Oasis - Live Forever (Official Video)', channel: 'Oasis', duration: 280, views: 1 }],
    'Oasis', 'Live Forever', 280
  );
  assert(ranked.length === 1, 'rankOfficialMv keeps "Live Forever" by Oasis');

  // D4: a missing yt-dlp is an error, not "no results".
  const searchErr = await youtube.ytSearch('anything').then(() => null, (e) => e.message);
  assert(searchErr && /yt-dlp/.test(searchErr), `ytSearch should reject when yt-dlp is missing, got: ${searchErr}`);

  // D7: a backup with no users keeps the current accounts; one with users still replaces them.
  users.createUser({ username: 'admin1', password: 'correct horse battery', role: 'admin' });
  const noUsers = backups.createBackup(db);
  noUsers.tables.users = [];
  backups.restoreBackup(db, noUsers);
  assert(users.countUsers() === 1, 'restoring a backup without users must not delete existing users');
  const withUsers = backups.createBackup(db);
  backups.restoreBackup(db, withUsers);
  assert(users.countUsers() === 1, 'restoring a backup with users restores them');

  // D13: a database error inside processNext is logged, not an unhandled rejection.
  let unhandled = null;
  process.on('unhandledRejection', (e) => { unhandled = e; });
  const realPrepare = db.prepare;
  const realError = console.error;
  let logged = false;
  console.error = () => { logged = true; };
  try {
    db.prepare = realPrepare;
    const originalPrepare = db.prepare;
    let calls = 0;
    db.prepare = function (...args) {
      calls++;
      if (calls === 3) { db.prepare = originalPrepare; throw new Error('simulated database failure'); }
      return originalPrepare.apply(this, args);
    };
    jobQueue.enqueue('track_download', 999999, 'follow-up test');
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    db.prepare = realPrepare;
    console.error = realError;
  }
  assert(logged, 'a failure inside the job queue loop should be logged');
  assert(unhandled === null, `no unhandled rejection expected, got: ${unhandled && unhandled.message}`);
}

main()
  .then(() => {
    db.close();
    fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
    console.log('Review follow-up tests OK');
  })
  .catch((e) => {
    console.error(e.message);
    fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  });
