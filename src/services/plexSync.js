// Keeps Ragearr and Plex in step, on a timer (see start) or on demand.
//
//  A. Plex -> Ragearr: each wanted list that follows a Plex playlist gets a track for every
//     song in the playlist. New tracks are searched for like any other (autoSearch). A song
//     taken out of the playlist stops being a member of the list.
//  B. Song deleted from the Plex music library -> Ragearr: the track and its video file go.
//     The file is moved to <root>/.trash for 30 days, not deleted at once. This only acts
//     after two syncs in a row both find the song gone, never in bulk, never when Plex looks
//     unwell (see the guards below).
//  C. Ragearr -> Plex: imported videos are added to the Plex collection that matches the list.
//     Videos whose song left the playlist are taken out of the collection (the file stays).
//     Videos that someone added to the collection by hand are left alone.
const db = require('../db');
const settings = require('./settings');
const importLists = require('./importLists');
const library = require('./library');
const rootFolders = require('./rootFolders');
const downloadClients = require('./downloadClients');
const qualityProfiles = require('./qualityProfiles');
const plex = require('./plex');

const MAX_DELETES_PER_RUN = 10;
const MISSING_RUNS_BEFORE_DELETE = 2;
const OUTAGE_FRACTION = 0.3; // this many songs "missing" at once looks like a broken Plex, not deletions
const OUTAGE_MIN_COUNT = 5;

let running = false;
let timer = null;

const keyFor = (artist, title) => importLists.keyFor({ artist, track_name: title });
const log = (action, detail) => db.prepare('INSERT INTO plex_log (action, detail) VALUES (?, ?)').run(action, typeof detail === 'string' ? detail : JSON.stringify(detail));

function defaultProfileId() {
  const id = (settings.get('quality') || {}).defaultProfileId;
  return qualityProfiles.isValid(id) ? id : qualityProfiles.DEFAULT_PROFILE_ID;
}

function syncedLists() {
  return db.prepare('SELECT * FROM wanted_lists WHERE plex_sync = 1 AND plex_playlist_key IS NOT NULL').all();
}

// ---- A: playlists -> lists ----
async function syncPlaylists(client, lists, out) {
  const tracks = db.prepare('SELECT * FROM tracks').all();
  const byRating = new Map(tracks.filter((t) => t.plex_rating_key).map((t) => [t.plex_rating_key, t]));
  const byKey = new Map(tracks.map((t) => [keyFor(t.artist, t.track_name), t]));
  const removedByList = new Map();

  for (const list of lists) {
    let items;
    try {
      items = await client.playlistItems(list.plex_playlist_key);
    } catch (e) {
      out.warnings.push(`Could not read Plex playlist for "${list.name}": ${e.message}`);
      continue;
    }
    const present = new Set();
    for (const item of items) {
      const artist = (item.artist || item.albumArtist || '').trim();
      const title = (item.title || '').trim();
      if (!artist || !title) continue;
      let track = byRating.get(item.ratingKey) || byKey.get(keyFor(artist, title));
      if (!track) {
        const info = db
          .prepare(
            `INSERT INTO tracks (wanted_list_id, artist, track_name, album, duration_sec, source_uri, monitored, quality_profile, plex_rating_key)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
          )
          .run(list.id, artist, title, item.album || null, item.durationSec || null, `plex:${item.ratingKey}`, defaultProfileId(), item.ratingKey);
        track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(info.lastInsertRowid);
        byRating.set(item.ratingKey, track);
        byKey.set(keyFor(artist, title), track);
        out.added++;
      } else if (track.plex_rating_key !== item.ratingKey) {
        db.prepare('UPDATE tracks SET plex_rating_key = ?, plex_missing = 0 WHERE id = ?').run(item.ratingKey, track.id);
        track.plex_rating_key = item.ratingKey;
        byRating.set(item.ratingKey, track);
      }
      present.add(track.id);
      db.prepare('INSERT OR IGNORE INTO plex_members (wanted_list_id, track_id) VALUES (?, ?)').run(list.id, track.id);
    }
    const members = db.prepare('SELECT track_id FROM plex_members WHERE wanted_list_id = ?').all(list.id);
    const gone = members.filter((m) => !present.has(m.track_id)).map((m) => m.track_id);
    for (const trackId of gone) db.prepare('DELETE FROM plex_members WHERE wanted_list_id = ? AND track_id = ?').run(list.id, trackId);
    if (gone.length) removedByList.set(list.id, gone);
    out.removedFromLists += gone.length;
  }
  return removedByList;
}

// ---- B: songs deleted from Plex ----
async function musicSectionKey(client) {
  const sections = await client.sections();
  return (sections.find((s) => s.type === 'artist') || {}).key || null;
}

async function syncDeletions(client, out, { force }) {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.* FROM tracks t
         JOIN plex_members m ON m.track_id = t.id
         JOIN wanted_lists l ON l.id = m.wanted_list_id AND l.plex_sync = 1
       WHERE t.plex_rating_key IS NOT NULL`
    )
    .all();
  if (!rows.length) return;

  const missing = [];
  let checked = 0;
  for (const track of rows) {
    let exists;
    try {
      exists = await client.songExists(track.plex_rating_key);
    } catch (e) {
      out.warnings.push(`Plex check failed (${e.message}); song deletions skipped this run.`);
      return;
    }
    checked++;
    if (exists) {
      if (track.plex_missing) db.prepare('UPDATE tracks SET plex_missing = 0 WHERE id = ?').run(track.id);
    } else {
      missing.push(track);
    }
  }
  if (!missing.length) return;

  // A song that was re-added to Plex has a new id: look for it by name before calling it gone.
  let musicKey = null;
  const reallyMissing = [];
  for (const track of missing) {
    let found = null;
    try {
      musicKey = musicKey || (await musicSectionKey(client));
      if (musicKey) {
        const candidates = await client.findSong(musicKey, track.track_name);
        const want = keyFor(track.artist, track.track_name);
        found = candidates.find((c) => keyFor(c.artist || c.albumArtist, c.title) === want || keyFor(c.albumArtist, c.title) === want);
      }
    } catch (e) {
      out.warnings.push(`Plex search failed (${e.message}); song deletions skipped this run.`);
      return;
    }
    if (found) db.prepare('UPDATE tracks SET plex_rating_key = ?, plex_missing = 0 WHERE id = ?').run(found.ratingKey, track.id);
    else reallyMissing.push(track);
  }
  if (!reallyMissing.length) return;

  if (reallyMissing.length >= OUTAGE_MIN_COUNT && reallyMissing.length / checked > OUTAGE_FRACTION) {
    out.warnings.push(`${reallyMissing.length} of ${checked} songs look missing from Plex at once. That looks like a Plex problem, so nothing was deleted.`);
    return;
  }

  const due = [];
  for (const track of reallyMissing) {
    const count = track.plex_missing + 1;
    db.prepare('UPDATE tracks SET plex_missing = ? WHERE id = ?').run(count, track.id);
    if (count >= MISSING_RUNS_BEFORE_DELETE) due.push(track);
  }
  if (!due.length) return;
  if (due.length > MAX_DELETES_PER_RUN && !force) {
    out.warnings.push(`${due.length} songs are due for deletion, more than the limit of ${MAX_DELETES_PER_RUN} per run. Nothing was deleted. Check Plex, then run the sync with "Allow bulk delete".`);
    out.blockedDeletes = due.length;
    return;
  }

  for (const track of due) {
    if (['downloading', 'searching'].includes(track.status)) continue; // try again next run
    try {
      let trashed = null;
      if (track.matched_file_path) {
        const root = rootFolders.rootForStored('music', track.root_folder_id);
        const conn = root ? downloadClients.libraryConnForRoot(root) : null;
        if (!root || !conn) throw new Error('library path or SSH connection is not configured');
        log('delete', { track: `${track.artist} - ${track.track_name}`, id: track.id, file: track.matched_file_path, plexRatingKey: track.plex_rating_key });
        trashed = await library.moveToTrash(conn, root.path, track.matched_file_path);
      } else {
        log('delete', { track: `${track.artist} - ${track.track_name}`, id: track.id, file: null, plexRatingKey: track.plex_rating_key });
      }
      db.transaction(() => {
        db.prepare('DELETE FROM candidates WHERE track_id = ?').run(track.id);
        db.prepare('DELETE FROM plex_members WHERE track_id = ?').run(track.id);
        db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);
      })();
      out.deleted.push({ track: `${track.artist} - ${track.track_name}`, trashedTo: trashed });
    } catch (e) {
      out.warnings.push(`Could not remove "${track.artist} - ${track.track_name}": ${e.message}`);
    }
  }
}

// ---- C: lists -> collections ----
function videoLookup(videos) {
  const map = new Map();
  for (const v of videos) {
    for (const file of v.files) {
      const parts = file.split('/');
      map.set(parts.slice(-2).join('/').toLowerCase(), { ratingKey: v.ratingKey, file });
    }
  }
  return (relPath) => {
    const parts = relPath.split('/');
    const hit = map.get(parts.slice(-2).join('/').toLowerCase());
    return hit && hit.file.toLowerCase().endsWith(`/${relPath.toLowerCase()}`) ? hit.ratingKey : null;
  };
}

async function syncCollections(client, lists, removedByList, videoSectionKey, out) {
  if (!videoSectionKey) {
    out.warnings.push('No Music Videos section chosen in Plex settings; collections were not updated.');
    return;
  }
  const videos = await client.videoItems(videoSectionKey);
  const lookup = videoLookup(videos);
  const collections = await client.collections(videoSectionKey);
  let needScan = false;

  for (const list of lists) {
    try {
      const title = (list.plex_collection || list.name || '').trim();
      if (!title) continue;
      const members = db
        .prepare(
          `SELECT t.* FROM tracks t JOIN plex_members m ON m.track_id = t.id
           WHERE m.wanted_list_id = ?`
        )
        .all(list.id);
      const desired = [];
      for (const t of members) {
        if (t.status !== 'imported' || !t.matched_file_path) continue;
        const key = lookup(t.matched_file_path);
        if (key) desired.push(key);
        else needScan = true;
      }
      const existing = collections.find((c) => c.title === title);
      if (!existing) {
        if (desired.length) {
          const key = await client.createCollection(videoSectionKey, title, desired);
          out.collectionsCreated.push(title);
          out.addedToCollections += desired.length;
          if (key) collections.push({ key, title });
        }
        continue;
      }
      const current = new Set(await client.collectionItems(existing.key));
      const toAdd = [...new Set(desired)].filter((k) => !current.has(k));
      if (toAdd.length) {
        await client.addToCollection(existing.key, toAdd);
        out.addedToCollections += toAdd.length;
      }
      const removed = removedByList.get(list.id) || [];
      for (const trackId of removed) {
        const t = db.prepare('SELECT matched_file_path FROM tracks WHERE id = ?').get(trackId);
        const key = t && t.matched_file_path ? lookup(t.matched_file_path) : null;
        if (key && current.has(key)) {
          await client.removeFromCollection(existing.key, key);
          out.removedFromCollections++;
        }
      }
    } catch (e) {
      out.warnings.push(`Collection update failed for "${list.name}": ${e.message}`);
    }
  }
  if (needScan && client.refreshSection) {
    try {
      await client.refreshSection(videoSectionKey);
    } catch (e) {
      out.warnings.push(`Could not ask Plex to scan the Music Videos library: ${e.message}`);
    }
  }
}

async function purgeTrashDaily(out) {
  const last = settings.get('plexLastTrashPurge');
  if (last && Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000) return;
  for (const root of rootFolders.roots('music')) {
    const conn = downloadClients.libraryConnForRoot(root);
    if (!conn) continue;
    try {
      const gone = await library.purgeTrash(conn, root.path);
      if (gone.length) log('purge', { root: root.path, files: gone.length });
      out.purged += gone.length;
    } catch (e) {
      out.warnings.push(`Trash purge failed for ${root.name}: ${e.message}`);
    }
  }
  settings.set('plexLastTrashPurge', new Date().toISOString());
}

async function run({ client, videoSectionKey, force = false } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const out = { at: new Date().toISOString(), added: 0, removedFromLists: 0, deleted: [], collectionsCreated: [], addedToCollections: 0, removedFromCollections: 0, purged: 0, warnings: [], blockedDeletes: 0 };
  try {
    const lists = syncedLists();
    const cfg = plex.getConfig();
    client = client || plex.clientFromSettings();
    videoSectionKey = videoSectionKey || cfg.videoSectionKey;
    const removedByList = await syncPlaylists(client, lists, out);
    await syncDeletions(client, out, { force });
    await syncCollections(client, syncedLists(), removedByList, videoSectionKey, out);
    await purgeTrashDaily(out);
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  } finally {
    running = false;
    settings.set('plexSyncStatus', out);
  }
  return out;
}

function status() {
  const last = settings.get('plexSyncStatus') || null;
  const recentLog = db.prepare('SELECT at, action, detail FROM plex_log ORDER BY id DESC LIMIT 20').all();
  return { config: plex.getConfig(), running, last, recentLog };
}

function start() {
  if (timer) return;
  const tick = async () => {
    try {
      const cfg = plex.getConfig();
      if (cfg.enabled && cfg.baseUrl && cfg.tokenSet) await run();
    } catch (e) {
      console.error('plex sync error:', e.message);
    }
  };
  setTimeout(tick, 60 * 1000);
  const loop = () => {
    timer = setTimeout(async () => {
      await tick();
      loop();
    }, plex.getConfig().intervalMinutes * 60 * 1000);
    timer.unref?.();
  };
  loop();
}

module.exports = { run, status, start, syncedLists, MAX_DELETES_PER_RUN, MISSING_RUNS_BEFORE_DELETE };
