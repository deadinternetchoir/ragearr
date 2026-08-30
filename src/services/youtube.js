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
// which is NOT frame-identical, so ffmpeg's freezedetect filter alone misses it).
// Confirmed on two real, user-reported cases: freezedetect found only ~7s of
// "frozen" content out of a ~275s video that's genuinely a static photo the
// whole way through. Scene-change counting (ffmpeg's scene-detection, counting
// frames where the scene score crosses a threshold) is a much stronger signal:
// a real produced music video has dozens to hundreds of cuts over a few minutes;
// a static/panned photo has essentially zero, pan or no pan. Validated: a known
// good video scored 184 scene changes over 210s (and 28 in just a 20s sample);
// both known-bad static videos scored 2 total, full-length. hasMotion() checks
// this on a short downloaded sample (not the full file) so a rejected candidate
// doesn't cost a full download.

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

// Downloads a short sample from partway through the video and counts scene
// changes in it, to reject static-image/slow-pan "videos" before committing
// to a full download. See the module header comment for why this approach
// (over ffmpeg's freezedetect alone) and the real numbers that validated it.
async function hasMotion(videoId, durationSec) {
  const sampleStart = durationSec && durationSec > 60 ? Math.floor(durationSec * 0.3) : 30;
  const sampleEnd = sampleStart + 20;
  const tmpFile = path.join(os.tmpdir(), `ragearr-motioncheck-${videoId}-${Date.now()}.mkv`);

  const downloaded = await new Promise((resolve) => {
    execFile(
      YTDLP,
      [
        '-f', 'bestvideo[vcodec!*=av01][height<=480]+bestaudio/best',
        '--download-sections', `*${sampleStart}-${sampleEnd}`,
        '--force-keyframes-at-cuts',
        '--merge-output-format', 'mkv',
        '--no-progress',
        '-o', tmpFile,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60000 },
      (err) => resolve(!err && fs.existsSync(tmpFile))
    );
  });

  if (!downloaded) {
    // Sample download itself failed - don't block on a motion check we
    // couldn't actually run; let the candidate through and let the real
    // download (or lack thereof) surface the problem instead.
    return true;
  }

  try {
    const sceneCount = await new Promise((resolve) => {
      execFile(
        FFMPEG,
        ['-i', tmpFile, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'],
        { maxBuffer: 20 * 1024 * 1024, timeout: 30000 },
        (err, stdout, stderr) => {
          const matches = (stderr || '').match(/Parsed_showinfo/g);
          resolve(matches ? matches.length : 0);
        }
      );
    });
    return sceneCount >= MOTION_CHECK_SCENE_THRESHOLD;
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// Walks a ranked candidate list best-first, running the motion check on each
// until one passes (real video) or the list runs out (all static/rejected).
// Returns { picked, rejected } - rejected is kept for visibility into what
// got skipped and why, useful for the review queue / debugging bad matches.
async function pickFirstWithMotion(ranked, durationSec) {
  const rejected = [];
  for (const candidate of ranked) {
    const ok = await hasMotion(candidate.video.id, durationSec || candidate.video.duration);
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
    const { picked, rejected } = await pickFirstWithMotion(highTierCandidates, durationSec);
    if (picked) {
      return { tier: 'high', type: 'official_mv', video: picked.video, score: picked.score, rejectedStatic: rejected };
    }
    // All high-tier candidates were static - fall through to medium-tier
    // ones (still real candidates, just less corroborated) rather than
    // giving up immediately.
  }

  const mediumTierCandidates = rankedMv.filter((c) => c.score >= 2 && !highTierCandidates.includes(c));
  if (mediumTierCandidates.length > 0) {
    const { picked, rejected } = await pickFirstWithMotion(mediumTierCandidates, durationSec);
    if (picked) {
      return { tier: 'medium', type: 'official_mv', video: picked.video, score: picked.score, rejectedStatic: rejected };
    }
  }

  const liveResults = await ytSearch(`${artist} ${trackName} live`);
  const rankedLive = rankOfficialLive(liveResults, artist, trackName);
  const liveCandidates = rankedLive.filter((c) => c.score >= 4);
  if (liveCandidates.length > 0) {
    const { picked, rejected } = await pickFirstWithMotion(liveCandidates, durationSec);
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
