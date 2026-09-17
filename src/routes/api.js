const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const settings = require('../services/settings');
const youtube = require('../services/youtube');
const prowlarr = require('../services/prowlarr');
const downloadClients = require('../services/downloadClients');
const library = require('../services/library');
const qualityProfiles = require('../services/qualityProfiles');
const candidateRules = require('../services/candidateRules');
const notifications = require('../services/notifications');
const thumbnails = require('../services/thumbnails');
const systemHealth = require('../services/systemHealth');
const importLists = require('../services/importLists');
const spotify = require('../services/spotify');
const rootFolders = require('../services/rootFolders');
const backups = require('../services/backups');
const users = require('../services/users');
const { sshExec, scpUpload } = require('../services/sshExec');
const jobQueue = require('../services/jobQueue');

const router = express.Router();

const LOCAL_DOWNLOAD_DIR = process.env.RAGEARR_DOWNLOAD_DIR || '/tmp/ragearr-dl';

// The actual download+upload work, now run by the job queue instead of
// inline in the route handler - see jobQueue.js for why. Looks the track
// and its selected candidate up fresh (time has passed since the job was
// queued), same real logic this route used to run synchronously.
jobQueue.registerHandler('track_download', async (job, progress) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(job.ref_id);
  if (!track) throw new Error('track no longer exists');
  const candidate = db.prepare('SELECT * FROM candidates WHERE track_id = ? AND selected = 1').get(track.id);
  if (!candidate) throw new Error('no candidate selected for this track');

  const conn = getLibrarySshConn();
  const root = rootFolders.defaultRoot('music');
  if (!conn || !root) throw new Error('Download client SSH connection / music-video root folder not configured');

  fs.mkdirSync(LOCAL_DOWNLOAD_DIR, { recursive: true });
  const localTemplate = path.join(LOCAL_DOWNLOAD_DIR, `${track.id}.%(ext)s`);
  const localFile = path.join(LOCAL_DOWNLOAD_DIR, `${track.id}.mkv`); // youtube.download always merges to mkv

  try {
    const profile = qualityProfiles.get(track.quality_profile || getDefaultQualityProfileId());
    progress('downloading via yt-dlp…');
    const dl = await youtube.download(candidate.external_id, localTemplate, profile);
    if (!dl.ok) throw new Error(dl.error || 'yt-dlp download failed');

    progress('uploading to library…');
    const relPath = library.musicVideoRelativePath(track.artist, track.track_name, 'mkv');
    const remoteDir = `${root.path}/${relPath.slice(0, relPath.lastIndexOf('/'))}`;
    await sshExec(conn, `mkdir -p '${remoteDir}'`);
    await scpUpload(conn, localFile, `${root.path}/${relPath}`, { timeout: 10 * 60 * 1000 });

    const thumbnailUrl = track.thumbnail_url || thumbnails.youtubeThumbnailUrl(candidate.external_id);
    db.prepare(
      "UPDATE tracks SET status = 'imported', matched_file_path = ?, root_folder_id = ?, thumbnail_url = COALESCE(thumbnail_url, ?), updated_at = datetime('now') WHERE id = ?"
    ).run(relPath, root.id, thumbnailUrl, track.id);
    notifications.notifyAndLog('onDownloadImported', {
      track,
      candidate,
      message: `Imported to ${root.name}/${relPath}`,
    });
  } catch (e) {
    db.prepare("UPDATE tracks SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(track.id);
    notifications.notifyAndLog('onDownloadFailed', { track, candidate, error: e.message });
    throw e;
  } finally {
    fs.rm(localFile, { force: true }, () => {});
  }
});

function getProwlarrClient() {
  const cfg = settings.get('prowlarr');
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    return null;
  }
  return prowlarr.makeClient(cfg);
}

function getRtorrentClient() {
  return downloadClients.makeClient('rtorrent');
}

function getDownloadClient() {
  return downloadClients.makeClient();
}

// Library scanning reuses the active download client's SSH connection details
// rather than storing a second, duplicate set of host/user/sshKeyPath under a
// "library" settings key. Only the library path itself needs its own setting.
function getLibrarySshConn() {
  return downloadClients.librarySshConn();
}

function getDefaultQualityProfileId() {
  const cfg = settings.get('quality') || {};
  return qualityProfiles.isValid(cfg.defaultProfileId) ? cfg.defaultProfileId : qualityProfiles.DEFAULT_PROFILE_ID;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isSafeRelativeLibraryPath(filePath) {
  return Boolean(
    filePath &&
      !String(filePath).includes('\\') &&
      !path.isAbsolute(filePath) &&
      !String(filePath).split('/').includes('..')
  );
}

function videoExtension(filePath) {
  const ext = path.posix.extname(String(filePath)).replace(/^\./, '').toLowerCase();
  return ext || 'mkv';
}

function rootLabel(root, filePath) {
  return root ? `${root.name}/${filePath}` : filePath;
}

function requireAdmin(req, res) {
  if (req.auth?.role === 'admin') return true;
  res.status(403).json({ error: 'admin access required' });
  return false;
}

function candidateWithThumbnail(row) {
  if (!row) return row;
  return {
    ...row,
    thumbnail_url: thumbnails.youtubeThumbnailUrl(row.external_id),
  };
}

async function tryGenerateTrackThumbnail(conn, rootPath, relPath, trackId) {
  try {
    return await thumbnails.generateRemoteFrame(conn, rootPath, relPath, trackId);
  } catch (e) {
    console.warn(`[thumbnails] track ${trackId}: ${e.message}`);
    return null;
  }
}

// --- Wanted lists ---

router.get('/wanted-lists', (req, res) => {
  const rows = db.prepare('SELECT * FROM wanted_lists ORDER BY created_at DESC').all();
  res.json(rows);
});

// --- Backup / restore ---

router.get('/backup/export', (req, res) => {
  const backup = backups.createBackup(db);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${backups.filename()}"`);
  res.json(backup);
});

router.post('/backup/preview', (req, res) => {
  try {
    const payload = req.body?.backup || req.body;
    const { summary } = backups.validateBackup(db, payload);
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/backup/restore', (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (req.body?.confirm !== 'RESTORE') return res.status(400).json({ error: 'confirm must be RESTORE' });
    const payload = req.body?.backup;
    const result = backups.restoreBackup(db, payload);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Auth / users ---

router.get('/auth/me', (req, res) => {
  res.json({ user: req.auth?.user || null, authType: req.auth?.type || null });
});

router.post('/auth/logout', (req, res) => {
  if (req.auth?.type === 'session') users.deleteSession(req.auth.token);
  res.json({ ok: true });
});

router.get('/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ users: users.listUsers() });
});

router.post('/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.status(201).json(users.createUser(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(users.updateUser(req.params.id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  try {
    const target = users.getUser(id);
    if (!target) return res.status(404).json({ error: 'user not found' });
    if (req.auth?.user?.id === id) return res.status(400).json({ error: 'cannot delete the current signed-in user' });
    const admins = users.listUsers().filter((user) => user.role === 'admin');
    if (target.role === 'admin' && admins.length <= 1) return res.status(400).json({ error: 'cannot delete the last admin user' });
    users.deleteUser(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/wanted-lists', (req, res) => {
  const { name, source_type } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare('INSERT INTO wanted_lists (name, source_type) VALUES (?, ?)')
    .run(name, source_type || 'manual');
  res.status(201).json({ id: info.lastInsertRowid, name, source_type: source_type || 'manual' });
});

// --- Tracks ---

router.get('/tracks', (req, res) => {
  const { wanted_list_id, status, monitored } = req.query;
  let sql = 'SELECT * FROM tracks WHERE 1=1';
  const params = [];
  if (wanted_list_id) {
    sql += ' AND wanted_list_id = ?';
    params.push(wanted_list_id);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (monitored === 'true' || monitored === 'false') {
    sql += ' AND monitored = ?';
    params.push(monitored === 'true' ? 1 : 0);
  }
  sql += ' ORDER BY id';
  res.json(db.prepare(sql).all(...params));
});

router.post('/tracks', (req, res) => {
  const { wanted_list_id, artist, track_name, album, duration_sec, source_uri, monitored, quality_profile } = req.body;
  if (!artist || !track_name) {
    return res.status(400).json({ error: 'artist and track_name are required' });
  }
  const profileId = quality_profile || getDefaultQualityProfileId();
  if (!qualityProfiles.isValid(profileId)) return res.status(400).json({ error: 'unknown quality profile' });
  const info = db
    .prepare(
      `INSERT INTO tracks (wanted_list_id, artist, track_name, album, duration_sec, source_uri, monitored, quality_profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      wanted_list_id || null,
      artist,
      track_name,
      album || null,
      duration_sec || null,
      source_uri || null,
      monitored === false ? 0 : 1,
      profileId
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

// --- Import lists ---

async function importListRowsFromBody(body) {
  if (!body?.url && !String(body?.text || '').trim()) {
    const err = new Error('paste a list or enter a URL first');
    err.statusCode = 400;
    throw err;
  }
  if (body.url) {
    const url = String(body.url).trim();
    if (importLists.isYouTubePlaylistUrl(url)) return importLists.fetchYouTubePlaylistRows(url);
    if (importLists.isSpotifyPlaylistUrl(url)) return spotify.playlistRows(url);
    return importLists.parseText(await importLists.fetchText(url));
  }
  return importLists.parseText(body.text || '');
}

function importListSourceType(body, rows) {
  if (body?.url && importLists.isYouTubePlaylistUrl(String(body.url).trim())) return 'youtube_playlist';
  if (body?.url && importLists.isSpotifyPlaylistUrl(String(body.url).trim())) return 'spotify_playlist';
  return importLists.sourceTypeFromRows(rows || []);
}

function existingTrackKeys() {
  return new Set(db.prepare('SELECT artist, track_name FROM tracks').all().map(importLists.keyFor));
}

router.post('/import-lists/preview', async (req, res) => {
  try {
    const rows = await importListRowsFromBody(req.body || {});
    const existing = existingTrackKeys();
    const seen = new Set();
    const preview = rows.map((row, index) => {
      const key = importLists.keyFor(row);
      const duplicateExisting = existing.has(key);
      const duplicateInImport = seen.has(key);
      seen.add(key);
      return {
        index,
        ...row,
        monitored: true,
        quality_profile: getDefaultQualityProfileId(),
        duplicateExisting,
        duplicateInImport,
        importable: !duplicateExisting && !duplicateInImport,
      };
    });
    res.json({
      source_type: importListSourceType(req.body || {}, rows),
      rows: preview,
      counts: {
        total: preview.length,
        importable: preview.filter((r) => r.importable).length,
        duplicateExisting: preview.filter((r) => r.duplicateExisting).length,
        duplicateInImport: preview.filter((r) => r.duplicateInImport).length,
      },
    });
  } catch (e) {
    res.status(e.statusCode || 502).json({ error: e.message });
  }
});

router.post('/import-lists/import', async (req, res) => {
  try {
    const rows = await importListRowsFromBody(req.body || {});
    const listName = (req.body?.name || '').trim();
    if (!listName) return res.status(400).json({ error: 'name is required' });
    const profileId = getDefaultQualityProfileId();
    const existing = existingTrackKeys();
    const seen = new Set();
    const importable = rows.filter((row) => {
      const key = importLists.keyFor(row);
      if (!row.artist || !row.track_name || existing.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const create = db.transaction((tracks) => {
      const listInfo = db
        .prepare('INSERT INTO wanted_lists (name, source_type) VALUES (?, ?)')
        .run(listName, importListSourceType(req.body || {}, tracks));
      const insertTrack = db.prepare(
        `INSERT INTO tracks (wanted_list_id, artist, track_name, album, duration_sec, source_uri, monitored, quality_profile)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
      );
      for (const row of tracks) {
        insertTrack.run(
          listInfo.lastInsertRowid,
          row.artist,
          row.track_name,
          row.album || null,
          row.duration_sec || null,
          row.source_uri || null,
          profileId
        );
      }
      return listInfo.lastInsertRowid;
    });
    if (importable.length === 0) return res.status(400).json({ error: 'no importable tracks found' });
    const listId = create(importable);
    res.status(201).json({ ok: true, wanted_list_id: listId, imported: importable.length, skipped: rows.length - importable.length });
  } catch (e) {
    res.status(e.statusCode || 502).json({ error: e.message });
  }
});

router.patch('/tracks/:id', (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'not found' });
  const updates = [];
  const params = [];
  if (typeof req.body.monitored === 'boolean') {
    updates.push('monitored = ?');
    params.push(req.body.monitored ? 1 : 0);
  }
  if (req.body.quality_profile !== undefined) {
    if (!qualityProfiles.isValid(req.body.quality_profile)) return res.status(400).json({ error: 'unknown quality profile' });
    updates.push('quality_profile = ?');
    params.push(req.body.quality_profile);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no supported fields supplied' });
  updates.push("updated_at = datetime('now')");
  params.push(track.id);
  db.prepare(`UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// Removes a track from Ragearr entirely. deleteFile (default true) also
// removes the real library file over SSH when the track has one - leaving the
// DB record gone but the file behind would just get
// it silently re-added as a "new" find on the next library scan, which
// defeats the point of deleting it. candidates rows are deleted explicitly
// rather than relying on the schema's ON DELETE CASCADE - better-sqlite3
// doesn't turn on `PRAGMA foreign_keys` by default, so that constraint is
// actually inert and would otherwise leave orphaned candidate rows behind.
router.delete('/tracks/:id', async (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'not found' });

  const deleteFile = req.body?.deleteFile !== false; // default true
  let fileDeleted = false;
  let fileWarning = null;

  if (deleteFile && track.matched_file_path) {
    const conn = getLibrarySshConn();
    const root = rootFolders.rootForStored('music', track.root_folder_id);
    if (conn && root) {
      try {
        await sshExec(conn, `rm -f ${shellQuote(`${root.path}/${track.matched_file_path}`)}`);
        fileDeleted = true;
      } catch (e) {
        fileWarning = `track removed from Ragearr, but failed to delete the file: ${e.message}`;
      }
    } else {
      fileWarning = 'track removed from Ragearr, but the library path/SSH connection is not configured - file was not touched';
    }
  }

  db.prepare('DELETE FROM candidates WHERE track_id = ?').run(track.id);
  db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);

  res.json({ ok: true, fileDeleted, warning: fileWarning });
});

// --- Candidates (review queue) ---

router.get('/tracks/:id/candidates', (req, res) => {
  const rows = db.prepare('SELECT * FROM candidates WHERE track_id = ? ORDER BY score DESC').all(req.params.id);
  res.json(rows.map(candidateWithThumbnail));
});

router.post('/candidates/:id/select', (req, res) => {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE candidates SET selected = 0 WHERE track_id = ?').run(candidate.track_id);
  db.prepare('UPDATE candidates SET selected = 1 WHERE id = ?').run(candidate.id);
  db.prepare("UPDATE tracks SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(candidate.track_id);
  res.json({ ok: true });
});

// The actual missing piece from the original design: selecting a candidate
// only ever marked it selected and set the track to 'approved' - nothing
// ever downloaded anything. This is that real download step: pulls the
// track's selected candidate via yt-dlp, uploads the result to the
// configured music-video library over SSH (same connection/path
// convention as the library scan - see library.js's musicVideoRelativePath,
// which guarantees a later scan will recognize this exact file rather than
// treating it as a new, unrelated find), and marks the track 'imported'.
// A real download (tens of MB to low hundreds), so this request blocks for
// the duration - the frontend shows its own "Downloading…" state on the
// button throughout, matching how /tracks/:id/search already blocks.
// Enqueues the real download+upload work instead of blocking the request
// for its full multi-minute duration (see jobQueue.js) - returns
// immediately with a job id the frontend polls via GET /jobs/:id. A
// second download requested while one is already running is queued behind
// it, not run concurrently - real, deliberate single-flight behaviour, not
// an accident of the old blocking design.
router.post('/tracks/:id/download', (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'not found' });

  const candidate = db.prepare('SELECT * FROM candidates WHERE track_id = ? AND selected = 1').get(track.id);
  if (!candidate) return res.status(400).json({ error: 'no candidate selected for this track' });
  if (candidate.source !== 'youtube') {
    return res.status(400).json({ error: `don't know how to download a '${candidate.source}' candidate` });
  }
  const conn = getLibrarySshConn();
  const root = rootFolders.defaultRoot('music');
  if (!conn) return res.status(400).json({ error: 'Download client SSH connection is not configured - see PUT /api/settings/download-client' });
  if (!root) return res.status(400).json({ error: 'No music-video root folder is configured - see PUT /api/settings/library' });

  db.prepare("UPDATE tracks SET status = 'downloading', updated_at = datetime('now') WHERE id = ?").run(track.id);
  const jobId = jobQueue.enqueue('track_download', track.id, `${track.artist} - ${track.track_name}`);
  res.status(202).json({ jobId });
});

router.get('/tracks/:id/manual-import/files', async (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'not found' });
  const conn = getLibrarySshConn();
  const roots = rootFolders.roots('music');
  if (!conn) return res.status(400).json({ error: 'Download client SSH connection is not configured - see PUT /api/settings/download-client' });
  if (roots.length === 0) return res.status(400).json({ error: 'No music-video root folders are configured - see PUT /api/settings/library' });

  const query = Object.prototype.hasOwnProperty.call(req.query, 'q')
    ? String(req.query.q || '').trim()
    : `${track.artist} ${track.track_name}`;
  try {
    const files = await library.searchMusicVideoFiles(conn, roots, query, 80);
    res.json({
      track_id: track.id,
      query,
      files: files.map((f) => ({
        ...f,
        filename: f.filePath.split('/').pop(),
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/tracks/:id/manual-import', async (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'not found' });
  const { filePath, moveRename, rootFolderId } = req.body || {};
  if (!isSafeRelativeLibraryPath(filePath)) {
    return res.status(400).json({ error: 'filePath must be a relative library path' });
  }
  const conn = getLibrarySshConn();
  const root = rootFolders.findRoot('music', rootFolderId);
  if (!conn) return res.status(400).json({ error: 'Download client SSH connection is not configured - see PUT /api/settings/download-client' });
  if (!root) return res.status(400).json({ error: 'No music-video root folder is configured - see PUT /api/settings/library' });

  try {
    const sourceAbs = `${root.path}/${filePath}`;
    await sshExec(conn, `test -f ${shellQuote(sourceAbs)}`, { timeout: 12000 });

    let finalPath = filePath;
    let moved = false;
    if (moveRename) {
      finalPath = library.musicVideoRelativePath(track.artist, track.track_name, videoExtension(filePath));
      const destAbs = `${root.path}/${finalPath}`;
      if (finalPath !== filePath) {
        const destDir = destAbs.slice(0, destAbs.lastIndexOf('/'));
        await sshExec(conn, `mkdir -p ${shellQuote(destDir)} && test ! -e ${shellQuote(destAbs)} && mv ${shellQuote(sourceAbs)} ${shellQuote(destAbs)}`, {
          timeout: 60000,
        });
        moved = true;
      }
    }

    const thumbUrl = await tryGenerateTrackThumbnail(conn, root.path, finalPath, track.id);
    db.prepare(
      "UPDATE tracks SET status = 'imported', matched_file_path = ?, root_folder_id = ?, thumbnail_url = COALESCE(?, thumbnail_url), updated_at = datetime('now') WHERE id = ?"
    ).run(finalPath, root.id, thumbUrl, track.id);
    res.json({ ok: true, filePath: finalPath, rootFolderId: root.id, rootFolderName: root.name, sourcePath: filePath, moved, thumbnail_url: thumbUrl || track.thumbnail_url || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Jobs (Activity) ---

router.get('/jobs', (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 100').all());
});

router.get('/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// --- System / health ---

router.get('/system/health', async (req, res) => {
  try {
    res.json(await systemHealth.run({ apiAuthConfigured: Boolean(process.env.RAGEARR_API_KEY) }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search YouTube for a candidate music video for one track, and record the
// result as a candidate row (does not download anything — that's a separate
// approve/download step, see the review-queue design in README.md).
router.post('/tracks/:id/search', async (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'not found' });

  db.prepare("UPDATE tracks SET status = 'searching', updated_at = datetime('now') WHERE id = ?").run(track.id);
  try {
    const result = await youtube.findCandidate({
      artist: track.artist,
      trackName: track.track_name,
      durationSec: track.duration_sec,
    }, candidateRules.get());

    if (result.video) {
      const thumbnailUrl = thumbnails.youtubeThumbnailUrl(result.video.id);
      db.prepare(
        `INSERT INTO candidates (track_id, source, external_id, title, origin, url, tier, score, metadata_json)
         VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        track.id,
        result.video.id,
        result.video.title,
        result.video.channel,
        `https://www.youtube.com/watch?v=${result.video.id}`,
        result.tier,
        result.score,
        JSON.stringify(result.video)
      );
      db.prepare('UPDATE tracks SET thumbnail_url = COALESCE(thumbnail_url, ?), updated_at = datetime(\'now\') WHERE id = ?').run(
        thumbnailUrl,
        track.id
      );
    }

    const newStatus = result.tier === 'none' ? 'no_match' : 'candidates_found';
    db.prepare("UPDATE tracks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, track.id);
    if (result.video) {
      notifications.notifyAndLog('onCandidateFound', {
        track,
        candidate: {
          title: result.video.title,
          url: `https://www.youtube.com/watch?v=${result.video.id}`,
        },
        message: `Match tier: ${result.tier}, score: ${result.score}`,
      });
    } else {
      notifications.notifyAndLog('onNoMatch', { track, message: 'Automatic search did not find a usable music video.' });
    }
    res.json({ track_id: track.id, tier: result.tier, video: result.video });
  } catch (e) {
    db.prepare("UPDATE tracks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(track.id);
    res.status(500).json({ error: e.message });
  }
});

// --- Settings ---

router.get('/settings/prowlarr', (req, res) => {
  const cfg = settings.get('prowlarr');
  // Never echo the API key back in full once saved.
  if (cfg && cfg.apiKey) cfg.apiKey = cfg.apiKey.slice(0, 4) + '…';
  res.json(cfg || {});
});

router.put('/settings/prowlarr', (req, res) => {
  const { baseUrl, apiKey } = req.body;
  if (!baseUrl || !apiKey) return res.status(400).json({ error: 'baseUrl and apiKey are required' });
  settings.set('prowlarr', { baseUrl, apiKey });
  res.json({ ok: true });
});

router.post('/settings/prowlarr/test', async (req, res) => {
  const client = getProwlarrClient();
  if (!client) return res.status(400).json({ error: 'Prowlarr is not configured' });
  try {
    const status = await client.get('/api/v1/system/status');
    const categories = await client.refreshMusicVideoCategories();
    res.json({
      ok: true,
      version: status?.version || null,
      musicVideoCategories: categories,
      message:
        categories.length > 0
          ? `Connected to Prowlarr ${status?.version || ''}; found ${categories.length} music-video categor${categories.length === 1 ? 'y' : 'ies'}.`
          : `Connected to Prowlarr ${status?.version || ''}, but no music-video-capable indexer categories were found.`,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/quality-profiles', (req, res) => {
  res.json({
    defaultProfileId: getDefaultQualityProfileId(),
    profiles: qualityProfiles.all(),
  });
});

router.put('/settings/quality', (req, res) => {
  const { defaultProfileId } = req.body;
  if (!qualityProfiles.isValid(defaultProfileId)) return res.status(400).json({ error: 'unknown quality profile' });
  settings.set('quality', { defaultProfileId });
  res.json({ ok: true });
});

router.get('/settings/candidate-rules', (req, res) => {
  res.json(candidateRules.get());
});

router.put('/settings/candidate-rules', (req, res) => {
  try {
    res.json(candidateRules.set(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/settings/spotify', (req, res) => {
  res.json(spotify.publicConfig());
});

router.put('/settings/spotify', (req, res) => {
  try {
    res.json(spotify.setConfig(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/settings/spotify/test', async (req, res) => {
  try {
    res.json(await spotify.testConnection());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/settings/notifications', (req, res) => {
  res.json(notifications.publicConfig());
});

router.put('/settings/notifications', (req, res) => {
  const { discordWebhookUrl, events } = req.body || {};
  const cfg = notifications.saveConfig({ discordWebhookUrl, events });
  res.json({ ok: true, ...cfg });
});

router.post('/settings/notifications/test', async (req, res) => {
  if (!notifications.publicConfig().configured) return res.status(400).json({ error: 'Discord webhook is not configured' });
  try {
    await notifications.notify('test', { message: 'Ragearr Connect is configured.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Concerts (Prowlarr-backed, artist-level, distinct from the per-track
// music-video pipeline above — see docs/prowlarr-notes.md for why) ---

router.get('/concerts/search', async (req, res) => {
  const { artist } = req.query;
  if (!artist) return res.status(400).json({ error: 'artist query param is required' });
  const client = getProwlarrClient();
  if (!client) return res.status(400).json({ error: 'Prowlarr is not configured — see PUT /api/settings/prowlarr' });
  try {
    const { results, warning } = await client.searchConcerts(artist);
    res.json({ results, warning });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/concerts/grabs', (req, res) => {
  res.json(db.prepare('SELECT * FROM concert_grabs ORDER BY created_at DESC').all());
});

router.get('/settings/rtorrent', (req, res) => {
  res.json(downloadClients.publicConfig('rtorrent'));
});

router.put('/settings/rtorrent', (req, res) => {
  const { host, user, sshKeyPath, socketPath } = req.body;
  try {
    downloadClients.setConfig('rtorrent', { host, user, sshKeyPath, socketPath });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/settings/rtorrent/test', async (req, res) => {
  const client = getRtorrentClient();
  if (!client) return res.status(400).json({ error: 'rTorrent is not configured' });
  try {
    const health = await downloadClients.checkActive();
    if (health.status === 'fail') return res.status(502).json({ error: health.message });
    let version = null;
    try {
      version = await client.getVersion();
    } catch (e) {
      return res.status(502).json({ error: `Socket is reachable, but rTorrent did not return a version: ${e.message}` });
    }
    res.json({ ok: true, version, message: `Connected to rTorrent ${version}` });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/settings/download-client', (req, res) => {
  res.json(downloadClients.publicConfig());
});

router.put('/settings/download-client', (req, res) => {
  const {
    type = 'rtorrent',
    host,
    user,
    sshKeyPath,
    socketPath,
    baseUrl,
    username,
    password,
    category,
    savePath,
  } = req.body || {};
  try {
    downloadClients.setConfig(type, { host, user, sshKeyPath, socketPath, baseUrl, username, password, category, savePath });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/settings/download-client/test', async (req, res) => {
  const client = getDownloadClient();
  if (!client) return res.status(400).json({ error: 'Download client is not configured' });
  try {
    const health = await downloadClients.checkActive();
    if (health.status === 'fail') return res.status(502).json({ error: health.message });
    let version = null;
    if (typeof client.getVersion === 'function') {
      try {
        version = await client.getVersion();
      } catch (e) {
        return res.status(502).json({ error: `${health.message}, but the client did not return a version: ${e.message}` });
      }
    }
    res.json({
      ok: true,
      type: downloadClients.activeType(),
      version,
      message: version ? `Connected to ${health.label} ${version}` : `Connected to ${health.label}`,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Grabbing a concert release actually dispatches it to the active download
// client. Uses the release's
// downloadUrl from a Prowlarr search result - Prowlarr proxies the real
// .torrent file through itself, so this URL can be handed to the configured
// client regardless of which underlying indexer it came from.
//
// `already_owned: true` records a release as already present on the target
// system (e.g. grabbed manually outside Ragearr before it existed, or via
// some other path) without touching rTorrent at all - lets Grabbed act as a
// real "what do I have" list rather than only ever tracking things Ragearr
// itself downloaded.
router.post('/concerts/grabs', async (req, res) => {
  const { artist, release_title, indexer_id, indexer_name, guid, download_url, metadata, already_owned } = req.body;
  if (!artist || !release_title) {
    return res.status(400).json({ error: 'artist and release_title are required' });
  }

  const info = db
    .prepare(
      `INSERT INTO concert_grabs (artist, release_title, indexer_id, indexer_name, guid, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(artist, release_title, indexer_id || null, indexer_name || null, guid || null, JSON.stringify(metadata || {}));
  const grabId = info.lastInsertRowid;

  if (already_owned) {
    // 'imported' - same status a concert would land on if Ragearr grabbed
    // and post-processed it itself (see the status enum in db.js); kept
    // consistent so a manual mark and a real download both mean the same
    // thing to the rest of the app, rather than a separate ad hoc value.
    db.prepare("UPDATE concert_grabs SET status = 'imported' WHERE id = ?").run(grabId);
    return res.status(201).json({ id: grabId, status: 'imported' });
  }

  if (!download_url) {
    return res.status(201).json({ id: grabId, status: 'grabbed', warning: 'no download_url provided, not dispatched to download client' });
  }

  const client = getDownloadClient();
  if (!client) {
    return res.status(201).json({ id: grabId, status: 'grabbed', warning: 'Download client is not configured - see PUT /api/settings/download-client' });
  }

  try {
    await client.addByUrl(download_url);
    db.prepare("UPDATE concert_grabs SET status = 'downloading' WHERE id = ?").run(grabId);
    res.status(201).json({ id: grabId, status: 'downloading' });
  } catch (e) {
    db.prepare("UPDATE concert_grabs SET status = 'failed' WHERE id = ?").run(grabId);
    res.status(502).json({ id: grabId, status: 'failed', error: e.message });
  }
});

// --- Library (real "what's actually on disk" scan, Radarr-style) ---

router.get('/settings/library', (req, res) => {
  res.json(rootFolders.getConfig());
});

router.put('/settings/library', (req, res) => {
  const { musicVideosPath, concertsPath, musicVideoRootFolders, concertRootFolders, defaultMusicVideosRootFolderId, defaultConcertRootFolderId } = req.body || {};
  if (!musicVideosPath && !concertsPath && !musicVideoRootFolders && !concertRootFolders) {
    return res.status(400).json({ error: 'At least one library root folder is required' });
  }
  const cfg = rootFolders.saveConfig({
    musicVideosPath,
    concertsPath,
    musicVideoRootFolders,
    concertRootFolders,
    defaultMusicVideosRootFolderId,
    defaultConcertRootFolderId,
  });
  res.json({ ok: true, ...cfg });
});

router.post('/settings/library/test', async (req, res) => {
  const conn = getLibrarySshConn();
  const libCfg = rootFolders.getConfig();
  if (!conn) return res.status(400).json({ error: 'Download client SSH connection is not configured' });
  const paths = [
    ...libCfg.musicVideoRootFolders.map((root) => ({ key: 'musicVideoRootFolders', label: `Music videos: ${root.name}`, path: root.path })),
    ...libCfg.concertRootFolders.map((root) => ({ key: 'concertRootFolders', label: `Concerts: ${root.name}`, path: root.path })),
  ];
  if (paths.length === 0) return res.status(400).json({ error: 'No library paths are configured' });

  const results = [];
  for (const entry of paths) {
    try {
      await sshExec(conn, `test -d '${entry.path}'`, { timeout: 12000 });
      results.push({ ...entry, status: 'ok', message: 'Reachable' });
    } catch (e) {
      results.push({ ...entry, status: 'fail', message: e.message });
    }
  }
  const failures = results.filter((r) => r.status === 'fail');
  res.status(failures.length ? 502 : 200).json({
    ok: failures.length === 0,
    paths: results,
    message: failures.length ? `${failures.length} configured path(s) failed.` : `${results.length} configured path(s) reachable.`,
  });
});

// Name of the wanted list new library-scan-discovered tracks land in -
// scanned files aren't part of any playlist/CSV import, so they get their
// own dedicated list rather than being silently attached to whichever list
// happened to be selected in the UI at scan time.
const LIBRARY_SCAN_LIST_NAME = 'Library';

function getOrCreateLibraryList() {
  const existing = db.prepare("SELECT id FROM wanted_lists WHERE name = ? AND source_type = 'library_scan'").get(LIBRARY_SCAN_LIST_NAME);
  if (existing) return existing.id;
  const info = db
    .prepare("INSERT INTO wanted_lists (name, source_type) VALUES (?, 'library_scan')")
    .run(LIBRARY_SCAN_LIST_NAME);
  return info.lastInsertRowid;
}

// Scans the real music-video library on disk (over SSH, using the active
// download client's SSH connection - see getLibrarySshConn above). Two things
// happen, matching how Radarr's own disk scan behaves:
//   1. Any existing track whose expected file is actually present gets
//      marked 'imported' with matched_file_path recorded - what makes a
//      track's status trustworthy as "do I actually have this" rather than
//      only ever reflecting what Ragearr itself downloaded.
//   2. Any real file with no corresponding track at all gets INSERTED as a
//      new track (into the "Library" wanted list, already 'imported') -
//      so scanning actually adds what it finds, not just verifies what was
//      already known about.
// Either way, Search/View candidates stay available per track afterward,
// same as Radarr letting you search for an upgrade on something you have.
router.post('/library/scan-music-videos', async (req, res) => {
  const conn = getLibrarySshConn();
  if (!conn) return res.status(400).json({ error: 'Download client SSH connection is not configured - see PUT /api/settings/download-client' });
  const roots = rootFolders.roots('music');
  if (roots.length === 0) {
    return res.status(400).json({ error: 'No music-video root folders are configured - see PUT /api/settings/library' });
  }

  // Every track, any status - a track already 'imported' by an earlier
  // scan still needs to be recognized as known, or it would be wrongly
  // re-inserted as a "new" find on every subsequent scan.
  const tracks = db.prepare('SELECT id, artist, track_name FROM tracks').all();

  try {
    const { files, matches, unmatched } = await library.scanMusicVideos(conn, roots, tracks);

    const update = db.prepare(
      "UPDATE tracks SET status = 'imported', matched_file_path = ?, root_folder_id = ?, updated_at = datetime('now') WHERE id = ?"
    );
    const insert = db.prepare(
      `INSERT INTO tracks (wanted_list_id, artist, track_name, status, matched_file_path, root_folder_id)
       VALUES (?, ?, ?, 'imported', ?, ?)`
    );
    const applyAll = db.transaction((ms, ns) => {
      for (const m of ms) update.run(m.filePath, m.rootFolderId, m.trackId);
      if (ns.length === 0) return;
      const listId = getOrCreateLibraryList();
      for (const n of ns) insert.run(listId, n.artist, n.trackName, n.filePath, n.rootFolderId);
    });
    applyAll(matches, unmatched);

    const thumbnailTargets = [
      ...matches.map((m) => ({ trackId: m.trackId, filePath: m.filePath, rootFolderId: m.rootFolderId })),
      ...unmatched
        .map((n) => db.prepare('SELECT id, matched_file_path, root_folder_id FROM tracks WHERE matched_file_path = ? AND root_folder_id = ?').get(n.filePath, n.rootFolderId))
        .filter(Boolean)
        .map((row) => ({ trackId: row.id, filePath: row.matched_file_path, rootFolderId: row.root_folder_id })),
    ];
    for (const target of thumbnailTargets) {
      const current = db.prepare('SELECT thumbnail_url FROM tracks WHERE id = ?').get(target.trackId);
      if (current?.thumbnail_url) continue;
      const root = rootFolders.findRoot('music', target.rootFolderId);
      if (!root) continue;
      const thumbUrl = await tryGenerateTrackThumbnail(conn, root.path, target.filePath, target.trackId);
      if (thumbUrl) {
        db.prepare("UPDATE tracks SET thumbnail_url = ?, updated_at = datetime('now') WHERE id = ?").run(thumbUrl, target.trackId);
      }
    }

    notifications.notifyAndLog('onLibraryScan', {
      message: 'Music video library scan finished.',
      scan: {
        Files: files.length,
        Matched: matches.length,
        Added: unmatched.length,
        Roots: roots.length,
      },
    });

    res.json({ filesScanned: files.length, tracksMatched: matches.length, tracksAdded: unmatched.length, rootsScanned: roots.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Same idea as the music-video scan above, applied to Concerts - matches
// concert_grabs rows against real release folders/files on disk (see
// library.js's scanConcerts for how release-title matching handles
// scene-release punctuation differences from a Prowlarr search result), and
// inserts a new concert_grabs row (already 'imported', no indexer info -
// it wasn't grabbed via Prowlarr) for any release found with no existing
// record at all.
router.post('/library/scan-concerts', async (req, res) => {
  const conn = getLibrarySshConn();
  if (!conn) return res.status(400).json({ error: 'Download client SSH connection is not configured - see PUT /api/settings/download-client' });
  const roots = rootFolders.roots('concerts');
  if (roots.length === 0) {
    return res.status(400).json({ error: 'No concert root folders are configured - see PUT /api/settings/library' });
  }

  const grabs = db.prepare('SELECT id, artist, release_title FROM concert_grabs').all();

  try {
    const { entries, matches, unmatched } = await library.scanConcerts(conn, roots, grabs);

    const update = db.prepare("UPDATE concert_grabs SET status = 'imported', matched_path = ?, root_folder_id = ? WHERE id = ?");
    const insert = db.prepare(
      `INSERT INTO concert_grabs (artist, release_title, status, matched_path, root_folder_id)
       VALUES (?, ?, 'imported', ?, ?)`
    );
    const applyAll = db.transaction((ms, ns) => {
      for (const m of ms) update.run(m.matchedPath, m.rootFolderId, m.grabId);
      for (const n of ns) insert.run(n.artist, n.releaseTitle, n.matchedPath, n.rootFolderId);
    });
    applyAll(matches, unmatched);

    notifications.notifyAndLog('onLibraryScan', {
      message: 'Concert library scan finished.',
      scan: {
        Entries: entries.length,
        Matched: matches.length,
        Added: unmatched.length,
        Roots: roots.length,
      },
    });

    res.json({ entriesScanned: entries.length, grabsMatched: matches.length, grabsAdded: unmatched.length, rootsScanned: roots.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
