const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

function fetchText(rawUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      reject(new Error('invalid URL'));
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error('URL must start with http:// or https://'));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, { timeout: 15000, headers: { Accept: 'text/csv,text/plain,*/*' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(new Error('import list is larger than 1MB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('URL fetch timed out')));
    req.on('error', reject);
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasHeader(cells) {
  const headers = cells.map(normalizeHeader);
  return headerIndex(headers, ['artist', 'artists', 'artistname', 'artistnames']) != null
    && headerIndex(headers, ['track', 'trackname', 'title', 'song', 'songname']) != null;
}

function headerIndex(headers, names) {
  for (const name of names) {
    const index = headers.indexOf(name);
    if (index !== -1) return index;
  }
  return null;
}

function rowFromCells(cells, headerMap) {
  if (headerMap) {
    return {
      artist: cells[headerMap.artist] || '',
      track_name: cells[headerMap.track_name] || '',
      album: headerMap.album != null ? cells[headerMap.album] || '' : '',
      duration_sec: headerMap.duration_sec != null ? parseDuration(cells[headerMap.duration_sec]) : null,
      source_uri: headerMap.source_uri != null ? cells[headerMap.source_uri] || '' : '',
    };
  }
  return {
    artist: cells[0] || '',
    track_name: cells[1] || '',
    album: cells[2] || '',
    duration_sec: parseDuration(cells[3]),
  };
}

function parseDuration(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?\s*ms$/i.test(text)) return parseFloat(text) / 1000;
  if (/^\d+(\.\d+)?$/.test(text)) return parseFloat(text);
  const parts = text.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseDurationMs(value) {
  if (!value) return null;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n / 1000 : null;
}

function isSpotifyPlaylistUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'open.spotify.com' && parsed.pathname.split('/').filter(Boolean)[0] === 'playlist';
}

function isSpotifySourceUri(value) {
  const text = String(value || '').trim();
  return /^spotify:track:/i.test(text) || /^https:\/\/open\.spotify\.com\/track\//i.test(text);
}

function isYouTubePlaylistUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return false;
  return parsed.pathname === '/playlist' || parsed.searchParams.has('list');
}

function youtubeVideoUrl(entry) {
  if (entry.webpage_url) return entry.webpage_url;
  const id = entry.id || entry.url;
  return id ? `https://www.youtube.com/watch?v=${id}` : '';
}

function cleanVideoTitle(value) {
  return String(value || '')
    .replace(/\s*[\[(]\s*(official\s+)?(music\s+)?video\s*[\])]\s*/gi, ' ')
    .replace(/\s*[\[(]\s*official\s*[\])]\s*/gi, ' ')
    .replace(/\s*[\[(]\s*(hd|hq|4k|8k)\s*[\])]\s*/gi, ' ')
    .replace(/\s+[-|]\s*(official\s+)?(music\s+)?video\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtist(value) {
  return String(value || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s+official$/i, '')
    .trim();
}

function parseYouTubeTitle(title, uploader) {
  const cleaned = cleanVideoTitle(title);
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return {
      artist: cleanArtist(parts[0]),
      track_name: cleanVideoTitle(parts.slice(1).join(' - ')),
    };
  }
  return {
    artist: cleanArtist(uploader || ''),
    track_name: cleaned,
  };
}

function playlistJson(rawUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ['--flat-playlist', '--dump-single-json', '--playlist-end', '500', rawUrl],
      { maxBuffer: 20 * 1024 * 1024, timeout: 90000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || 'yt-dlp playlist fetch failed').trim()));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('yt-dlp returned invalid playlist data'));
        }
      }
    );
  });
}

async function fetchYouTubePlaylistRows(rawUrl) {
  if (!isYouTubePlaylistUrl(rawUrl)) throw new Error('not a YouTube playlist URL');
  const data = await playlistJson(rawUrl);
  return rowsFromYouTubePlaylistData(data);
}

function rowsFromYouTubePlaylistData(data) {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const rows = [];
  for (const entry of entries) {
    if (!entry || entry.title === '[Deleted video]' || entry.title === '[Private video]') continue;
    const parsed = parseYouTubeTitle(entry.title, entry.uploader || entry.channel);
    parsed.artist = String(parsed.artist || '').trim();
    parsed.track_name = String(parsed.track_name || '').trim();
    if (!parsed.artist || !parsed.track_name) continue;
    rows.push({
      artist: parsed.artist,
      track_name: parsed.track_name,
      album: '',
      duration_sec: parseDuration(entry.duration),
      source_uri: youtubeVideoUrl(entry),
      source_title: entry.title || '',
    });
  }
  return rows;
}

function parseText(input) {
  const rows = [];
  const lines = String(input || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let headerMap = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let cells;
    if (line.includes(',') || line.includes('\t')) {
      cells = line.includes('\t') ? line.split('\t').map((c) => c.trim()) : splitCsvLine(line);
    } else {
      const parts = line.split(/\s+-\s+/);
      cells = parts.length >= 2 ? [parts[0], parts.slice(1).join(' - ')] : ['', line];
    }

    if (i === 0 && hasHeader(cells)) {
      const headers = cells.map(normalizeHeader);
      headerMap = {
        artist: headerIndex(headers, ['artist', 'artists', 'artistname', 'artistnames']),
        track_name: headerIndex(headers, ['trackname', 'track', 'title', 'song', 'songname']),
        album: headerIndex(headers, ['albumname', 'album']),
        duration_sec: headerIndex(headers, ['durationsec', 'durationseconds', 'duration']),
        duration_ms: headerIndex(headers, ['durationms', 'durationmilliseconds', 'trackdurationms']),
        source_uri: headerIndex(headers, ['trackuri', 'spotifyuri', 'trackurl', 'spotifyurl', 'url', 'uri']),
      };
      continue;
    }

    const row = rowFromCells(cells, headerMap);
    if (headerMap?.duration_ms != null) row.duration_sec = parseDurationMs(cells[headerMap.duration_ms]);
    row.artist = String(row.artist || '').trim();
    row.track_name = String(row.track_name || '').trim();
    row.album = String(row.album || '').trim();
    row.source_uri = String(row.source_uri || '').trim();
    if (row.artist && row.track_name) rows.push(row);
  }
  return rows;
}

function sourceTypeFromRows(rows) {
  return rows.some((row) => isSpotifySourceUri(row.source_uri)) ? 'spotify_export' : 'import_list';
}

function keyFor(row) {
  return `${String(row.artist).trim().toLowerCase()}::${String(row.track_name).trim().toLowerCase()}`;
}

module.exports = {
  fetchText,
  parseText,
  keyFor,
  isSpotifyPlaylistUrl,
  isSpotifySourceUri,
  sourceTypeFromRows,
  isYouTubePlaylistUrl,
  parseYouTubeTitle,
  rowsFromYouTubePlaylistData,
  fetchYouTubePlaylistRows,
};
