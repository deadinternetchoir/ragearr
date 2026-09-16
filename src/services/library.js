// Real library scan, matching Radarr's actual disk-scan behaviour: not just
// "does this file match something I already know about", but "add whatever
// I find that I don't already have a record for." The library may live on a
// remote host, so this is an SSH `find` over the configured library path,
// using the same access shape already used for SSH-backed download clients.
//
// File naming convention this matches against: `<musicVideosPath>/<Artist>/<Artist>
// - <Track Name>.<ext>`.

const { sshExec } = require('./sshExec');

const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'webm', 'avi', 'mov'];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Same normalization approach as youtube.js's own title matching -
// lowercase, strip punctuation down to alphanumerics+spaces, collapse
// whitespace - so minor differences (curly vs straight apostrophes, an
// extra comma, a sanitize() pass stripping a colon) don't cause a real
// on-disk file to be missed.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Strip filesystem-unsafe characters that are awkward on common Windows/Linux
// library mounts.
function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

// The one place that knows how a track maps to a real library path -
// matches parseMusicVideoEntry's reverse direction exactly, so anything
// downloaded through this convention is guaranteed to be found again by a
// later scan rather than silently duplicating it as "new."
function musicVideoRelativePath(artist, trackName, ext) {
  const a = sanitizeFilename(artist);
  const t = sanitizeFilename(trackName);
  return `${a}/${a} - ${t}.${ext}`;
}

// Lists every video file under remotePath via SSH, one relative path per
// line. Uses -iname alternation for the extensions above; NUL-separated
// output would be more robust against filenames containing newlines, but
// filenames created by Ragearr's own naming convention never do, and
// \n-separated keeps the remote command simple.
async function listFiles(conn, remotePath) {
  const nameClauses = VIDEO_EXTENSIONS.map((ext) => `-iname '*.${ext}'`).join(' -o ');
  const cmd = `find ${shellQuote(remotePath)} -type f \\( ${nameClauses} \\) -printf '%P\\n'`;
  const out = await sshExec(conn, cmd, { timeout: 60000 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function searchMusicVideoFiles(conn, roots, query, limit = 50) {
  const terms = normalize(query).split(' ').filter(Boolean);
  const results = [];
  for (const root of roots) {
    const files = await listFiles(conn, root.path);
    for (const f of files) {
      if (results.length >= limit) break;
      if (terms.length > 0) {
        const haystack = normalize(f);
        if (!terms.every((term) => haystack.includes(term))) continue;
      }
      results.push({ rootFolderId: root.id, rootFolderName: root.name, filePath: f });
    }
    if (results.length >= limit) break;
  }
  return results;
}

// Parses a `<Artist>/<file>` relative path into {artist, trackName}. The
// basename is expected as "<Artist> - <Track Name>.<ext>" (this project's
// established convention) - strips the artist prefix if present, otherwise
// falls back to the whole basename as the track name so an oddly-named
// file still gets imported as *something* rather than silently dropped.
function parseMusicVideoEntry(relPath) {
  const slash = relPath.lastIndexOf('/');
  if (slash === -1) return null; // expects <Artist>/<file>, skip anything looser
  const artist = relPath.slice(0, slash);
  const base = relPath.slice(slash + 1).replace(/\.[^.]+$/, '');
  const prefix = `${artist} - `;
  const trackName = base.startsWith(prefix) ? base.slice(prefix.length) : base;
  return { artist, trackName, filePath: relPath };
}

// Scans the remote music-video library against every known track (any
// status - a track needs to be found even if it was already marked
// 'imported' by an earlier scan, so it isn't wrongly re-added as new) and
// returns:
//   - matches: [{ trackId, filePath }] for existing tracks whose file is on disk
//   - unmatched: [{ artist, trackName, filePath }] for real files with no
//     corresponding track row at all - the caller inserts these as new
//     tracks, which is the actual "scan finds what you have" behaviour.
// Doesn't touch the DB itself - keeps DB writes in the route layer, this
// project's existing convention (see prowlarr.js/rtorrent.js).
async function scanMusicVideos(conn, rootFolders, allTracks) {
  // Index known tracks by normalized "artist::artist - track" key for a
  // direct lookup per file rather than an O(files * tracks) scan.
  const byKey = new Map();
  for (const t of allTracks) {
    byKey.set(`${normalize(t.artist)}::${normalize(`${t.artist} - ${t.track_name}`)}`, t);
  }

  const files = [];
  const matches = [];
  const unmatched = [];
  for (const root of rootFolders) {
    const rootFiles = await listFiles(conn, root.path);
    for (const f of rootFiles) {
      files.push({ rootFolderId: root.id, filePath: f });
      const parsed = parseMusicVideoEntry(f);
      if (!parsed) continue;
      const key = `${normalize(parsed.artist)}::${normalize(`${parsed.artist} - ${parsed.trackName}`)}`;
      const existing = byKey.get(key);
      if (existing) {
        matches.push({ trackId: existing.id, rootFolderId: root.id, filePath: f });
      } else {
        unmatched.push({ ...parsed, rootFolderId: root.id });
      }
    }
  }

  return { files, matches, unmatched };
}

// Concerts scan: matches concert_grabs rows against real files/folders
// under <remotePath>/<Artist>/<release>. Unlike tracks (whose filenames
// Ragearr's own naming convention controls exactly), a concert's
// release_title comes verbatim from a Prowlarr/indexer search result and
// may differ slightly in punctuation/spacing from the real on-disk release
// folder name (e.g. "S&M2 2019" vs "S&M2.2019", scene-release dots vs
// spaces) - so this matches by normalized substring containment rather
// than requiring an exact normalized match, in both directions, since
// either side could be the more/less detailed one.
async function listArtistEntries(conn, remotePath) {
  // one level below <remotePath>/<Artist>/ - a release is usually its own
  // folder, but handle a lone file too (single-file torrents happen)
  const cmd = `find ${shellQuote(remotePath)} -mindepth 2 -maxdepth 2 \\( -type d -o -type f \\) -printf '%P\\n'`;
  const out = await sshExec(conn, cmd, { timeout: 60000 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function titlesMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

function parseConcertEntry(relPath) {
  const slash = relPath.indexOf('/');
  if (slash === -1) return null;
  const artist = relPath.slice(0, slash);
  let releaseTitle = relPath.slice(slash + 1);
  // strip a video-file extension so a lone-file release doesn't carry
  // ".mkv" into its title, matching how a folder-based release has none
  if (/\.[a-z0-9]{2,4}$/i.test(releaseTitle)) {
    releaseTitle = releaseTitle.replace(/\.[a-z0-9]{2,4}$/i, '');
  }
  return { artist, releaseTitle, matchedPath: relPath };
}

// Same "match existing, surface what's new" shape as scanMusicVideos above,
// applied to concert_grabs.
async function scanConcerts(conn, rootFolders, allGrabs) {
  const entries = [];
  const matches = [];
  const unmatched = [];
  for (const root of rootFolders) {
    const rootEntries = await listArtistEntries(conn, root.path);
    for (const e of rootEntries) {
      entries.push({ rootFolderId: root.id, matchedPath: e });
      const parsed = parseConcertEntry(e);
      if (!parsed) continue;
      const existing = allGrabs.find(
        (g) => titlesMatch(parsed.artist, g.artist) && titlesMatch(parsed.releaseTitle, g.release_title)
      );
      if (existing) {
        matches.push({ grabId: existing.id, rootFolderId: root.id, matchedPath: e });
      } else {
        unmatched.push({ ...parsed, rootFolderId: root.id });
      }
    }
  }

  return { entries, matches, unmatched };
}

module.exports = { scanMusicVideos, scanConcerts, searchMusicVideoFiles, normalize, sanitizeFilename, musicVideoRelativePath };
