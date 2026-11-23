const settings = require('./settings');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

let cachedToken = null;

function playlistIdFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host !== 'open.spotify.com' || parts[0] !== 'playlist' || !parts[1]) return null;
  return parts[1];
}

function configured() {
  const cfg = settings.get('spotify') || {};
  return Boolean(cfg.clientId && cfg.clientSecret);
}

function publicConfig() {
  const cfg = settings.get('spotify') || {};
  return {
    configured: Boolean(cfg.clientId && cfg.clientSecret),
    clientId: cfg.clientId || '',
    clientSecret: cfg.clientSecret ? '••••••••' : '',
  };
}

function setConfig({ clientId, clientSecret }) {
  const current = settings.get('spotify') || {};
  const next = {
    clientId: String(clientId || current.clientId || '').trim(),
    clientSecret: String(clientSecret || current.clientSecret || '').trim(),
  };
  if (!next.clientId || !next.clientSecret) throw new Error('clientId and clientSecret are required');
  settings.set('spotify', next);
  cachedToken = null;
  return publicConfig();
}

async function accessToken() {
  const cfg = settings.get('spotify') || {};
  if (!cfg.clientId || !cfg.clientSecret) {
    const err = new Error('Spotify API credentials are not configured - see Settings > Spotify');
    err.statusCode = 400;
    throw err;
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.token;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Spotify token request failed: HTTP ${res.status}`);
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 0) * 1000),
  };
  return cachedToken.token;
}

async function apiGet(path) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Spotify API request failed: HTTP ${res.status}`);
    err.spotifyStatus = res.status;
    throw err;
  }
  return data;
}

function rowFromSpotifyTrack(track) {
  if (!track || track.type !== 'track') return null;
  return {
    artist: (track.artists || []).map((artist) => artist.name).filter(Boolean).join(', '),
    track_name: track.name || '',
    album: track.album?.name || '',
    duration_sec: track.duration_ms ? track.duration_ms / 1000 : null,
    source_uri: track.uri || track.external_urls?.spotify || '',
  };
}

function rowsFromPlaylistItems(items) {
  const rows = [];
  for (const item of items || []) {
    const row = rowFromSpotifyTrack(item?.track);
    if (row?.artist && row?.track_name) rows.push(row);
  }
  return rows;
}

// Rows from the track list that Spotify's public embed page carries. No login or API
// credentials are needed, but the page lists at most about 100 tracks.
function rowsFromEmbedHtml(html) {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html || '');
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const list = data?.props?.pageProps?.state?.data?.entity?.trackList;
  if (!Array.isArray(list)) return [];
  const clean = (text) => String(text || '').replace(/[\s\u00a0]+/g, ' ').trim();
  const rows = [];
  for (const t of list) {
    const artist = clean(t.subtitle);
    const track_name = clean(t.title);
    if (!artist || !track_name || (t.entityType && t.entityType !== 'track')) continue;
    rows.push({ artist, track_name, album: '', duration_sec: t.duration ? t.duration / 1000 : null, source_uri: t.uri || '' });
  }
  return rows;
}

async function embedRows(playlistId) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${encodeURIComponent(playlistId)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ragearr)' },
  });
  if (!res.ok) throw new Error(`Spotify embed page request failed: HTTP ${res.status}`);
  const rows = rowsFromEmbedHtml(await res.text());
  if (!rows.length) throw new Error('Spotify did not return any tracks for this playlist (is it public?)');
  return rows;
}

async function playlistRows(rawUrl) {
  const playlistId = playlistIdFromUrl(rawUrl);
  if (!playlistId) throw new Error('not a Spotify playlist URL');
  // Spotify now refuses playlist contents to an app-only token (403), and API credentials are
  // optional, so fall back to the embed page in both cases.
  if (!configured()) return embedRows(playlistId);
  try {
    return await apiPlaylistRows(playlistId);
  } catch (e) {
    if (e.spotifyStatus === 403 || e.spotifyStatus === 401) return embedRows(playlistId);
    throw e;
  }
}

async function apiPlaylistRows(playlistId) {
  const fields = 'items(track(name,artists(name),album(name),duration_ms,uri,external_urls.spotify,type)),next';
  let path = `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&fields=${encodeURIComponent(fields)}`;
  const rows = [];
  let pageCount = 0;
  while (path && pageCount < 10) {
    const page = await apiGet(path);
    rows.push(...rowsFromPlaylistItems(page.items));
    path = page.next ? page.next.replace(API_BASE, '') : null;
    pageCount++;
  }
  return rows;
}

async function testConnection() {
  await accessToken();
  return { ok: true, message: 'Spotify API credentials are valid.' };
}

module.exports = {
  playlistIdFromUrl,
  configured,
  publicConfig,
  setConfig,
  playlistRows,
  rowsFromPlaylistItems,
  rowsFromEmbedHtml,
  testConnection,
};
