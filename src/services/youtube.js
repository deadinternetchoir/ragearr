// YouTube-based fallback candidate source, using yt-dlp for search and download.
//
// This scoring logic has been validated against a real 148-track playlist
// (117 correctly matched as high-confidence, 28 flagged for review, 3 no-match).
// Known gaps, worth fixing:
//   - Cover songs sometimes match the *original* artist's video instead of the
//     covering artist's (channel-match gate helps but isn't foolproof — needs
//     an explicit "is this a cover" signal, e.g. checking if the query artist
//     appears anywhere in the candidate title/channel at all before accepting).
//
// Static-image / slow-pan "official videos": real finding, worth knowing before
// touching hasMotion() below. Some officially-tagged, correctly-matched uploads
// are just a still photo (sometimes with a slow Ken Burns-style pan/zoom applied,
// which is NOT frame-identical, so ffmpeg's freezedetect filter alone misses it -
// confirmed on a real case: freezedetect found only ~7s of "frozen" content out
// of a ~275s video that's genuinely a static photo the whole way through).
// Scene-change counting is a much stronger signal: a real produced music video
// has dozens to hundreds of cuts over a few minutes; a static/panned photo has
// essentially zero, pan or no pan. hasMotion() runs this against YouTube's own
// storyboard sprite images (the seek-bar hover-preview tiles) rather than any
// part of the actual video - tiny (tens of KB) and covers the video's entire
// duration, not just one sampled slice. Full validation numbers and the
// sample-download approach this replaced (worked, but cost more and only saw
// one slice of the timeline) are in the comment on hasMotion() itself.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const MOTION_CHECK_SCENE_THRESHOLD = 5; // minimum scene changes in the sample to count as "real video"

function ytSearch(query, count = 6) {
  return new Promise((resolve) => {
    execFile(
      YTDLP,
      [
        '--flat-playlist',
        '--print',
        '%(id)s\t%(title)s\t%(channel)s\t%(duration)s\t%(view_count)s',
        `ytsearch${count}:${query}`,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 45000 },
      (err, stdout) => {
        if (err && !stdout) return resolve([]);
        const lines = stdout.split('\n').filter(Boolean);
        resolve(
          lines.map((l) => {
            const [id, title, channel, duration, views] = l.split('\t');
            return { id, title, channel, duration: parseFloat(duration) || null, views: parseInt(views, 10) || 0 };
          })
        );
      }
    );
  });
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function channelMatchesArtist(channel, artist) {
  const nc = normalize(channel);
  const na = normalize(artist);
  if (!nc || !na) return false;
  return nc.includes(na) || na.includes(nc);
}

function coreTrackName(name) {
  return name
    .replace(/\(feat\.[^)]*\)/gi, '')
    .replace(/\bfeat\.[^,(]*/gi, '')
    .replace(/\(.*?\)/g, '')
    .trim();
}

// Hard gate: does the candidate title actually correspond to this track?
function titleMatchesTrack(candidateTitle, trackName) {
  const core = coreTrackName(trackName);
  const nCore = normalize(core);
  const nCand = normalize(candidateTitle);
  if (!nCore) return false;
  if (nCand.includes(nCore)) return true;

  const words = core
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return nCand.includes(nCore);
  let hits = 0;
  for (const w of words) {
    if (nCand.includes(normalize(w))) hits++;
  }
  return hits / words.length >= 0.7;
}

const EXCLUDE_PHRASES = [
  /full album stream/i,
  /official audio/i,
  /audio stream/i,
  /isolated vocals/i,
  /\blyric/i,
  /\bcover\b/i,
  /\breaction\b/i,
];

function isExcluded(title) {
  return EXCLUDE_PHRASES.some((re) => re.test(title));
}

// Returns every plausible candidate ranked best-first (not just the top one),
// so findCandidate() can fall through to the next-best if the top pick turns
// out to be a static image (see hasMotion() below).
function rankOfficialMv(results, artist, trackName, trackDurationSec) {
  const ranked = [];
  for (const r of results) {
    if (!r.title || !r.channel) continue;
    if (isExcluded(r.title)) continue;
    if (!titleMatchesTrack(r.title, trackName)) continue;
    const titleLower = r.title.toLowerCase();
    let score = 0;
    const isOfficialTag = /official\s*(music\s*)?video/.test(titleLower);
    const isLive = /\blive\b|\bconcert\b/.test(titleLower);
    const chMatch = channelMatchesArtist(r.channel, artist);
    if (isOfficialTag) score += 3;
    if (chMatch) score += 3;
    if (r.duration && trackDurationSec) {
      const diff = Math.abs(r.duration - trackDurationSec);
      if (diff < 15) score += 2;
      else if (diff < 40) score += 1;
      else if (diff > 90) score -= 2;
    }
    if (isLive) score -= 1;
    ranked.push({ video: r, score, chMatch });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function rankOfficialLive(results, artist, trackName) {
  const ranked = [];
  for (const r of results) {
    if (!r.title || !r.channel) continue;
    if (isExcluded(r.title)) continue;
    if (!titleMatchesTrack(r.title, trackName)) continue;
    const titleLower = r.title.toLowerCase();
    const isLive = /\blive\b|\bconcert\b|\bfestival\b|\bsession\b/.test(titleLower);
    const chMatch = channelMatchesArtist(r.channel, artist);
    if (!chMatch) continue; // only trust official-channel live performances
    let score = 2; // baseline for channel match
    if (isLive) score += 3;
    ranked.push({ video: r, score, chMatch });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

// Checks for real motion using YouTube's own storyboard sprite images (the
// tiles used for the seek-bar hover preview) instead of downloading any part
// of the actual video. Tried a "download a ~20s sample, run scene-detect on
// it" approach first - it worked, but costs several MB and only sees one
// slice of the timeline (a real video with a long intro could land the
// sample on a static/slow segment and be wrongly rejected). Storyboards are
// tiny (tens of KB total, validated: ~40KB-175KB for a 3-4 minute song) and
// cover the ENTIRE video's duration in a few dozen tiles, at essentially no
// cost - strictly better on both cost and reliability. Validated against the
// same real cases as the sample-based approach: known-good video scored 34
// scene changes across its full-duration tile set, both confirmed-static
// videos scored 2 - same clean separation, no video download needed at all.
//
// Falls back to allowing the candidate through if no storyboard is available
// (e.g. some livestreams/restricted content don't have one) - same
// fail-open philosophy as the rest of this module: don't block on a check
// that couldn't actually run.
const TILE_SIZE = 90; // YouTube's storyboard tile size, consistent across sb0-sb3

function fetchStoryboardMhtml(videoId) {
  const tmpFile = path.join(os.tmpdir(), `ragearr-storyboard-${videoId}-${Date.now()}.mhtml`);
  return new Promise((resolve) => {
    execFile(
      YTDLP,
      ['-f', 'sb1', '--no-progress', '-o', tmpFile, `https://www.youtube.com/watch?v=${videoId}`],
      { maxBuffer: 5 * 1024 * 1024, timeout: 30000 },
      (err) => resolve(!err && fs.existsSync(tmpFile) ? tmpFile : null)
    );
  });
}

// Storyboard sprite images are embedded in the .mhtml as raw binary (no
// base64/Content-Transfer-Encoding), one part per "Content-type: image/webp"
// block, sized per its own declared Content-length header.
function extractStoryboardImages(mhtmlPath) {
  const buf = fs.readFileSync(mhtmlPath);
  const text = buf.toString('latin1');
  const re = /Content-type: image\/webp\r?\nContent-length: (\d+)\r?\n[^]*?\r?\n\r?\n/g;
  const images = [];
  let m;
  while ((m = re.exec(text))) {
    const len = parseInt(m[1], 10);
    const start = m.index + m[0].length;
    images.push(buf.subarray(start, start + len));
  }
  return images;
}

async function sliceIntoTiles(webpBuffers, tileDir) {
  let n = 0;
  for (const webpBuf of webpBuffers) {
    const gridPath = path.join(tileDir, `grid_${n}.webp`);
    fs.writeFileSync(gridPath, webpBuf);
    const dims = await new Promise((resolve) => {
      execFile(FFMPEG, ['-i', gridPath], { timeout: 10000 }, (err, stdout, stderr) => {
        const dm = (stderr || '').match(/Stream.*Video.* (\d+)x(\d+)/);
        resolve(dm ? { w: parseInt(dm[1], 10), h: parseInt(dm[2], 10) } : null);
      });
    });
    if (!dims) continue;
    const cols = Math.floor(dims.w / TILE_SIZE);
    const rows = Math.floor(dims.h / TILE_SIZE);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const outPath = path.join(tileDir, `tile_${String(n).padStart(4, '0')}.png`);
        await new Promise((resolve) => {
          execFile(
            FFMPEG,
            ['-y', '-i', gridPath, '-vf', `crop=${TILE_SIZE}:${TILE_SIZE}:${col * TILE_SIZE}:${row * TILE_SIZE}`, '-frames:v', '1', outPath],
            { timeout: 10000 },
            () => resolve()
          );
        });
        n++;
      }
    }
  }
  return n;
}

async function countSceneChangesInTiles(tileDir, tileCount) {
  if (tileCount < 2) return 0;
  const videoPath = path.join(tileDir, 'synthetic.mp4');
  await new Promise((resolve) => {
    execFile(
      FFMPEG,
      ['-y', '-framerate', '1', '-i', path.join(tileDir, 'tile_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath],
      { timeout: 20000 },
      () => resolve()
    );
  });
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      ['-i', videoPath, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'],
      { maxBuffer: 20 * 1024 * 1024, timeout: 30000 },
      (err, stdout, stderr) => {
        const matches = (stderr || '').match(/Parsed_showinfo/g);
        resolve(matches ? matches.length : 0);
      }
    );
  });
}

async function hasMotion(videoId) {
  const mhtmlPath = await fetchStoryboardMhtml(videoId);
  if (!mhtmlPath) return true; // no storyboard available - don't block on it

  const tileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-tiles-'));
  try {
    const images = extractStoryboardImages(mhtmlPath);
    if (images.length === 0) return true; // couldn't parse - fail open
    const tileCount = await sliceIntoTiles(images, tileDir);
    const sceneCount = await countSceneChangesInTiles(tileDir, tileCount);
    return sceneCount >= MOTION_CHECK_SCENE_THRESHOLD;
  } finally {
    fs.rmSync(tileDir, { recursive: true, force: true });
    fs.unlink(mhtmlPath, () => {});
  }
}

// Walks a ranked candidate list best-first, running the motion check on each
// until one passes (real video) or the list runs out (all static/rejected).
// Returns { picked, rejected } - rejected is kept for visibility into what
// got skipped and why, useful for the review queue / debugging bad matches.
async function pickFirstWithMotion(ranked) {
  const rejected = [];
  for (const candidate of ranked) {
    const ok = await hasMotion(candidate.video.id);
    if (ok) return { picked: candidate, rejected };
    rejected.push(candidate.video.id);
  }
  return { picked: null, rejected };
}

/**
 * Find a music video candidate for a track. Returns
 * { tier: 'high'|'medium'|'none', type: 'official_mv'|'official_live'|null,
 *   video, score, rejectedStatic }
 * rejectedStatic lists any candidate video IDs that scored well but were
 * rejected by the motion check (static image / slow-pan) before this pick.
 */
async function findCandidate({ artist, trackName, durationSec }) {
  const mvResults = await ytSearch(`${artist} ${trackName} official music video`);
  const rankedMv = rankOfficialMv(mvResults, artist, trackName, durationSec);

  const highTierCandidates = rankedMv.filter(
    (c) => c.score >= 5 && (c.chMatch || c.video.views > 50000)
  );
  if (highTierCandidates.length > 0) {
    const { picked, rejected } = await pickFirstWithMotion(highTierCandidates);
    if (picked) {
      return { tier: 'high', type: 'official_mv', video: picked.video, score: picked.score, rejectedStatic: rejected };
    }
    // All high-tier candidates were static - fall through to medium-tier
    // ones (still real candidates, just less corroborated) rather than
    // giving up immediately.
  }

  const mediumTierCandidates = rankedMv.filter((c) => c.score >= 2 && !highTierCandidates.includes(c));
  if (mediumTierCandidates.length > 0) {
    const { picked, rejected } = await pickFirstWithMotion(mediumTierCandidates);
    if (picked) {
      return { tier: 'medium', type: 'official_mv', video: picked.video, score: picked.score, rejectedStatic: rejected };
    }
  }

  const liveResults = await ytSearch(`${artist} ${trackName} live`);
  const rankedLive = rankOfficialLive(liveResults, artist, trackName);
  const liveCandidates = rankedLive.filter((c) => c.score >= 4);
  if (liveCandidates.length > 0) {
    const { picked, rejected } = await pickFirstWithMotion(liveCandidates);
    if (picked) {
      return { tier: 'medium', type: 'official_live', video: picked.video, score: picked.score, rejectedStatic: rejected };
    }
  }

  return { tier: 'none', type: null, video: null, score: 0, rejectedStatic: [] };
}

function download(videoId, outPathTemplate) {
  return new Promise((resolve) => {
    execFile(
      YTDLP,
      [
        // AV1 excluded deliberately: no released NVIDIA Shield TV model has
        // hardware AV1 decode, and software decode at 4K isn't viable there.
        '-f', 'bestvideo[vcodec!*=av01]+bestaudio/best',
        '--merge-output-format', 'mkv',
        '--no-progress',
        '-o', outPathTemplate,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, error: err ? stderr || err.message : null });
      }
    );
  });
}

module.exports = { findCandidate, download, titleMatchesTrack, channelMatchesArtist };
