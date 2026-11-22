#!/usr/bin/env node
// Plex playlist/collection sync, trash handling, auto-approve and "Incorrect" on a
// downloaded video. Temp database and temp library folder; Plex is a fake client,
// nothing is searched or downloaded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-plex-'));
process.env.RAGEARR_DATA_DIR = path.join(tmp, 'config');
process.env.RAGEARR_KNOWN_HOSTS = path.join(tmp, 'known_hosts');
process.env.RAGEARR_API_KEY = 'test-key';

const db = require('../src/db');
const settings = require('../src/services/settings');
const rootFolders = require('../src/services/rootFolders');
const library = require('../src/services/library');
const plexSync = require('../src/services/plexSync');
const youtube = require('../src/services/youtube');
const jobQueue = require('../src/services/jobQueue');
const { LOCAL_CONN, sshExec } = require('../src/services/sshExec');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const rootPath = path.join(tmp, 'Music Videos');
fs.mkdirSync(rootPath, { recursive: true });
rootFolders.saveConfig({ musicVideoRootFolders: `Music Videos | ${rootPath} | local` });
const root = rootFolders.defaultRoot('music');
assert(root && root.local, 'local root folder should be configured');

// ---- fake Plex ----
function fakePlex() {
  const state = {
    playlists: { P1: [] },
    songs: new Set(),
    collections: {},
    nextKey: 900,
    failExists: false,
    scans: 0,
  };
  const song = (key, artist, title) => ({ ratingKey: String(key), title, artist, albumArtist: artist, album: 'A', durationSec: 200 });
  const client = {
    sections: async () => [{ key: '1', title: 'Music', type: 'artist' }, { key: '4', title: 'Music Videos', type: 'movie' }],
    playlistItems: async (key) => state.playlists[key].map((s) => ({ ...s })),
    songExists: async (key) => {
      if (state.failExists) throw new Error('Plex is down');
      return state.songs.has(String(key));
    },
    findSong: async (section, title) => [...state.playlists.P1, ...(state.extraSongs || [])].filter((s) => s.title === title && state.songs.has(s.ratingKey)),
    videoItems: async () => {
      const files = db.prepare("SELECT matched_file_path p FROM tracks WHERE matched_file_path IS NOT NULL").all();
      return files
        .filter((f) => fs.existsSync(path.join(rootPath, f.p)))
        .map((f) => ({ ratingKey: `v:${f.p}`, title: f.p, files: [`/data/Media/MusicVideos/${f.p}`] }));
    },
    collections: async () => Object.entries(state.collections).map(([key, c]) => ({ key, title: c.title })),
    collectionItems: async (key) => [...state.collections[key].items],
    createCollection: async (section, title, keys) => {
      const key = `C${state.nextKey++}`;
      state.collections[key] = { title, items: new Set(keys) };
      return key;
    },
    addToCollection: async (key, keys) => keys.forEach((k) => state.collections[key].items.add(k)),
    removeFromCollection: async (key, k) => state.collections[key].items.delete(k),
    refreshSection: async () => { state.scans++; },
  };
  return { state, client, song };
}

function importTrack(id, relPath) {
  const full = path.join(rootPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'video');
  db.prepare("UPDATE tracks SET status = 'imported', matched_file_path = ?, root_folder_id = ? WHERE id = ?").run(relPath, root.id, id);
}

const trackByTitle = (t) => db.prepare('SELECT * FROM tracks WHERE track_name = ?').get(t);
const sync = (client, opts = {}) => plexSync.run({ client, videoSectionKey: '4', ...opts });

async function main() {
  // basic list/collection/removal behaviour
  const { state, client, song } = fakePlex();
  const listId = db.prepare("INSERT INTO wanted_lists (name, source_type, plex_sync, plex_playlist_key, plex_collection, auto_approve) VALUES ('Mix', 'plex_playlist', 1, 'P1', 'Mix', 1)").run().lastInsertRowid;
  state.playlists.P1 = ['Four', 'Five', 'Six', 'Seven'].map((t, i) => song(201 + i, `Art${i}`, t));
  state.playlists.P1.forEach((s) => state.songs.add(s.ratingKey));
  await sync(client);
  for (const t of ['Four', 'Five', 'Six', 'Seven']) importTrack(trackByTitle(t).id, `Art/${t}.mkv`);

  // an imported file Plex has not scanned yet: requests a scan, collection catches up next run
  const origVideos = client.videoItems;
  client.videoItems = async () => (await origVideos()).filter((v) => !v.title.includes('Seven'));
  let r = await sync(client);
  const coll = Object.values(state.collections).find((c) => c.title === 'Mix');
  assert(coll.items.size === 3 && state.scans === 1, 'unscanned video is skipped and a scan is requested');
  client.videoItems = origVideos;
  await sync(client);
  assert(coll.items.size === 4, 'collection catches up after the scan');

  // hand-added item stays; song removed from the playlist leaves the collection but not the disk
  coll.items.add('v:HAND/Added.mkv');
  state.playlists.P1 = state.playlists.P1.filter((s) => s.title !== 'Five');
  r = await sync(client);
  assert(r.removedFromLists === 1, 'one song left the playlist');
  assert(!coll.items.has('v:Art/Five.mkv') && coll.items.has('v:HAND/Added.mkv'), 'removed song leaves the collection, hand-added item stays');
  assert(fs.existsSync(path.join(rootPath, 'Art/Five.mkv')), 'file of a song removed from a playlist stays on disk');
  assert(trackByTitle('Five'), 'track entry stays');
  assert(db.prepare('SELECT COUNT(*) n FROM plex_members WHERE track_id = ?').get(trackByTitle('Five').id).n === 0, 'no longer a member');

  // the same song written differently in Plex reuses the existing track
  const k = plexSync.keyFor;
  assert(k('Bring Me the Horizon ft. Lil Uzi Vert & Daryl Palumbo', 'AmEN!') === k('Bring Me The Horizon', 'AmEN! (feat. Lil Uzi Vert and Daryl Palumbo)'), 'feat. in artist or title is ignored');
  assert(k('Silverstein', 'Don\u2019t Let Me Get Too Low') === k('Silverstein', "Don't Let Me Get Too Low"), 'curly apostrophe is ignored');
  assert(k('Bring Me the Horizon', 'Kool\u2010Aid') === k('Bring Me The Horizon', 'Kool-Aid'), 'unicode hyphen is ignored');
  assert(k('Enter Shikari', 'Spaceship Earth (I. Avec Abandon)') !== k('Enter Shikari', 'Spaceship Earth (II. Angoscioso)'), 'different parts stay different');
  assert(k('Silverstein', 'Drain The Blood') === k('Silverstein feat. Rory Rodriguez', 'Drain the Blood'), 'case and credit differences match');

  // song added to the playlist later becomes a track
  state.playlists.P1.push(song(299, 'New', 'Eight'));
  state.songs.add('299');
  r = await sync(client);
  assert(r.added === 1 && trackByTitle('Eight'), 'new playlist song is added');

  // B. song deleted from Plex: two syncs, then trash; nothing happens on the first
  const six = trackByTitle('Six');
  state.songs.delete('203');
  r = await sync(client);
  assert(r.deleted.length === 0 && trackByTitle('Six').plex_missing === 1, 'first sync only counts');
  assert(fs.existsSync(path.join(rootPath, 'Art/Six.mkv')), 'file still there after one miss');
  r = await sync(client);
  assert(r.deleted.length === 1, `second sync deletes, got ${JSON.stringify(r.deleted)} ${JSON.stringify(r.warnings)}`);
  assert(!trackByTitle('Six'), 'track entry deleted');
  assert(!fs.existsSync(path.join(rootPath, 'Art/Six.mkv')), 'file left the library');
  const trashed = (await sshExec(LOCAL_CONN, `find ${JSON.stringify(rootPath)}/.trash -name 'Six.mkv'`)).trim();
  assert(trashed, 'file is in .trash');
  assert(db.prepare("SELECT COUNT(*) n FROM plex_log WHERE action = 'delete'").get().n === 1, 'deletion was logged');
  assert(db.prepare('SELECT COUNT(*) n FROM candidates WHERE track_id = ?').get(six.id).n === 0, 'candidates gone');

  // a song that came back with a new Plex id is re-matched, not deleted
  state.songs.delete('204');
  state.playlists.P1.find((s) => s.title === 'Seven').ratingKey = '204';
  state.extraSongs = [song(777, 'Art3', 'Seven')];
  state.songs.add('777');
  await sync(client);
  await sync(client);
  assert(trackByTitle('Seven') && trackByTitle('Seven').plex_missing === 0, 're-added song is kept');

  // Plex failure is never read as deletion
  state.failExists = true;
  r = await sync(client);
  assert(r.deleted.length === 0 && r.warnings.some((w) => /Plex check failed/.test(w)), 'outage skips deletions with a warning');
  state.failExists = false;

  // library scan ignores .trash
  const scan = await library.scanMusicVideos(() => LOCAL_CONN, [root], []);
  assert(!scan.files.some((f) => f.filePath.startsWith('.trash')), 'scan must not list .trash');

  // purge: files older than 30 days go, newer ones stay
  const old = path.join(rootPath, '.trash', '2000-01-01', 'Old');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'Old.mkv'), 'x');
  await sshExec(LOCAL_CONN, `touch -d '2000-01-01' ${JSON.stringify(path.join(old, 'Old.mkv'))}`);
  const gone = await library.purgeTrash(LOCAL_CONN, rootPath);
  assert(gone.length === 1 && !fs.existsSync(path.join(old, 'Old.mkv')), 'old trash purged');
  assert(!fs.existsSync(old), 'empty trash folders removed');
  assert(fs.existsSync(trashed), 'recent trash kept');
  const refused = await library.moveToTrash(LOCAL_CONN, rootPath, '../escape.mkv').then(() => null, (e) => e.message);
  assert(refused && /unsafe/.test(refused), 'unsafe path refused');
}

async function guards() {
  // many songs missing at once looks like a broken Plex
  const { state, client, song } = fakePlex();
  db.prepare("INSERT INTO wanted_lists (name, source_type, plex_sync, plex_playlist_key, plex_collection) VALUES ('Big', 'plex_playlist', 1, 'P1', 'Big')").run();
  db.prepare("UPDATE wanted_lists SET plex_sync = 0 WHERE name IN ('Party', 'Mix')").run();
  state.playlists.P1 = Array.from({ length: 20 }, (_, i) => song(300 + i, `B${i}`, `Big ${i}`));
  state.playlists.P1.forEach((s) => state.songs.add(s.ratingKey));
  await sync(client);
  for (let i = 0; i < 8; i++) state.songs.delete(String(300 + i));
  await sync(client);
  let r = await sync(client);
  assert(r.deleted.length === 0 && r.warnings.some((w) => /look missing from Plex at once/.test(w)), 'mass disappearance deletes nothing');

  // a handful of real deletions above the per-run cap needs force
  state.songs = new Set(state.playlists.P1.map((s) => s.ratingKey));
  db.prepare('UPDATE tracks SET plex_missing = 0').run();
  const more = Array.from({ length: 200 }, (_, i) => song(1000 + i, `C${i}`, `Many ${i}`));
  state.playlists.P1 = state.playlists.P1.concat(more);
  more.forEach((s) => state.songs.add(s.ratingKey));
  await sync(client);
  for (let i = 0; i < 12; i++) state.songs.delete(String(1000 + i));
  await sync(client);
  r = await sync(client);
  assert(r.deleted.length === 0 && r.blockedDeletes === 12, `cap should block 12 deletions, got ${r.blockedDeletes} / ${JSON.stringify(r.warnings)}`);
  r = await sync(client, { force: true });
  assert(r.deleted.length === 12, 'force allows the bulk delete');
}

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path: url, headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function routes() {
  // stub the YouTube search; keep the download job from running
  let tier = 'high';
  youtube.findCandidate = async () => ({ tier, score: 9, video: { id: 'vid' + Math.random().toString(36).slice(2, 8), title: 'Official', channel: 'Chan' } });
  jobQueue.registerHandler('track_download', async () => {});
  jobQueue.registerHandler('track_search', async () => {});

  const express = require('express');
  const apiRouter = require('../src/routes/api');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { role: 'admin' }; next(); });
  app.use('/api', apiRouter);
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  try {
    // link a Plex playlist as a list
    const created = await request(port, 'POST', '/api/plex/lists', { playlistKey: 'Z9', name: 'Zed' });
    assert(created.status === 201 && created.body.auto_approve === 1 && created.body.plex_sync === 1, 'plex list is created with auto-approve on');
    const dupe = await request(port, 'POST', '/api/plex/lists', { playlistKey: 'Z9', name: 'Zed2' });
    assert(dupe.status === 409, 'same playlist cannot be linked twice');

    // auto-approve: high tier downloads without review, medium waits
    const hi = db.prepare("INSERT INTO tracks (wanted_list_id, artist, track_name, status) VALUES (?, 'H', 'High', 'pending')").run(created.body.id).lastInsertRowid;
    const me = db.prepare("INSERT INTO tracks (wanted_list_id, artist, track_name, status) VALUES (?, 'M', 'Medium', 'pending')").run(created.body.id).lastInsertRowid;
    const manual = db.prepare("INSERT INTO tracks (wanted_list_id, artist, track_name, status) VALUES (1, 'N', 'Manual list', 'pending')").run().lastInsertRowid;
    db.prepare("UPDATE wanted_lists SET auto_approve = 0 WHERE id = 1").run();
    await request(port, 'POST', `/api/tracks/${hi}/search`);
    const hiRow = db.prepare('SELECT status FROM tracks WHERE id = ?').get(hi);
    assert(hiRow.status === 'downloading', `high-tier match on an auto-approve list should queue a download, got ${hiRow.status}`);
    assert(db.prepare('SELECT COUNT(*) n FROM candidates WHERE track_id = ? AND selected = 1').get(hi).n === 1, 'candidate selected');
    tier = 'medium';
    await request(port, 'POST', `/api/tracks/${me}/search`);
    assert(db.prepare('SELECT status FROM tracks WHERE id = ?').get(me).status === 'candidates_found', 'medium match waits for review');
    tier = 'high';
    await request(port, 'POST', `/api/tracks/${manual}/search`);
    assert(db.prepare('SELECT status FROM tracks WHERE id = ?').get(manual).status === 'candidates_found', 'a list without auto-approve still waits');

    // Incorrect on the video already in the library: file trashed, replacement searched
    const full = path.join(rootPath, 'H', 'H - High.mkv');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'video');
    db.prepare("UPDATE tracks SET status = 'imported', matched_file_path = 'H/H - High.mkv', root_folder_id = ? WHERE id = ?").run(root.id, hi);
    const cand = db.prepare('SELECT id FROM candidates WHERE track_id = ? AND selected = 1').get(hi);
    const rej = await request(port, 'POST', `/api/candidates/${cand.id}/reject`);
    assert(rej.status === 200 && rej.body.removedFile === true, `reject should remove the file, got ${JSON.stringify(rej.body)}`);
    assert(!fs.existsSync(full), 'video file is gone from the library');
    const after = db.prepare('SELECT status, matched_file_path FROM tracks WHERE id = ?').get(hi);
    assert(after.status === 'pending' && after.matched_file_path === null, 'track returns to pending with no file');
    assert(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'track_search' AND ref_id = ?").get(hi).n >= 1, 'replacement search is queued');
    assert(db.prepare('SELECT rejected FROM candidates WHERE id = ?').get(cand.id).rejected === 1, 'candidate marked rejected');

    // Incorrect on a candidate that was never downloaded changes no files
    const cands = db.prepare('SELECT id FROM candidates WHERE track_id = ? AND selected = 0 AND rejected = 0').get(me);
    const plain = await request(port, 'POST', `/api/candidates/${cands.id}/reject`);
    assert(plain.status === 200 && plain.body.removedFile === false, 'unselected reject only hides the candidate');
  } finally {
    server.close();
  }
}

(async () => {
  try {
    await main();
    await guards();
    await routes();
    console.log('plex sync tests passed');
    process.exit(0);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
})();
