const express = require('express');
const db = require('../db');
const settings = require('../services/settings');
const youtube = require('../services/youtube');
const prowlarr = require('../services/prowlarr');
const rtorrent = require('../services/downloadClients/rtorrent');

const router = express.Router();

function getProwlarrClient() {
  const cfg = settings.get('prowlarr');
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    return null;
  }
  return prowlarr.makeClient(cfg);
}

function getRtorrentClient() {
  const cfg = settings.get('rtorrent');
  if (!cfg || !cfg.host || !cfg.user || !cfg.sshKeyPath || !cfg.socketPath) {
    return null;
  }
  return rtorrent.makeClient(cfg);
}

// --- Wanted lists ---

router.get('/wanted-lists', (req, res) => {
  const rows = db.prepare('SELECT * FROM wanted_lists ORDER BY created_at DESC').all();
  res.json(rows);
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
  const { wanted_list_id, status } = req.query;
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
  sql += ' ORDER BY id';
  res.json(db.prepare(sql).all(...params));
});

router.post('/tracks', (req, res) => {
  const { wanted_list_id, artist, track_name, album, duration_sec, source_uri } = req.body;
  if (!artist || !track_name) {
    return res.status(400).json({ error: 'artist and track_name are required' });
  }
  const info = db
    .prepare(
      `INSERT INTO tracks (wanted_list_id, artist, track_name, album, duration_sec, source_uri)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(wanted_list_id || null, artist, track_name, album || null, duration_sec || null, source_uri || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

// --- Candidates (review queue) ---

router.get('/tracks/:id/candidates', (req, res) => {
  const rows = db.prepare('SELECT * FROM candidates WHERE track_id = ? ORDER BY score DESC').all(req.params.id);
  res.json(rows);
});

router.post('/candidates/:id/select', (req, res) => {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE candidates SET selected = 0 WHERE track_id = ?').run(candidate.track_id);
  db.prepare('UPDATE candidates SET selected = 1 WHERE id = ?').run(candidate.id);
  db.prepare("UPDATE tracks SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(candidate.track_id);
  res.json({ ok: true });
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
    });

    if (result.video) {
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
    }

    const newStatus = result.tier === 'none' ? 'no_match' : 'candidates_found';
    db.prepare("UPDATE tracks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, track.id);
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
  res.json(settings.get('rtorrent') || {});
});

router.put('/settings/rtorrent', (req, res) => {
  const { host, user, sshKeyPath, socketPath } = req.body;
  if (!host || !user || !sshKeyPath || !socketPath) {
    return res.status(400).json({ error: 'host, user, sshKeyPath, and socketPath are required' });
  }
  settings.set('rtorrent', { host, user, sshKeyPath, socketPath });
  res.json({ ok: true });
});

// Grabbing a concert release actually dispatches it to rTorrent (requires
// PUT /api/settings/rtorrent to be configured first). Uses the release's
// downloadUrl from a Prowlarr search result - Prowlarr proxies the real
// .torrent file through itself, so this URL works directly with rTorrent's
// load.start regardless of which underlying indexer it came from.
router.post('/concerts/grabs', async (req, res) => {
  const { artist, release_title, indexer_id, indexer_name, guid, download_url, metadata } = req.body;
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

  if (!download_url) {
    return res.status(201).json({ id: grabId, status: 'grabbed', warning: 'no download_url provided, not dispatched to rTorrent' });
  }

  const client = getRtorrentClient();
  if (!client) {
    return res.status(201).json({ id: grabId, status: 'grabbed', warning: 'rTorrent is not configured - see PUT /api/settings/rtorrent' });
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

module.exports = router;
