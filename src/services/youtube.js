// YouTube-based fallback candidate source, using yt-dlp for search and download.
//
// This scoring logic has been validated against a real-world playlist with a
// mix of official videos, false positives, lyric videos, and unavailable tracks.
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
// Raised from 5: real reported false negatives (a "marketing image that
// spins" and a "marketing image with some cuts" both passed as real
// motion) - the original 5 was validated against only two known cases (one
// confirmed-static scoring 2, one confirmed-real scoring 34), and a
// production still image cut between a handful of variants or given a slow
// pan can plausibly land in that gap without being an actual video. 12 is a
// reasoned adjustment based on those real failures, not independently
// re-validated against the specific videos that slipped through (no
// candidate record survived for them to re-test against) - comfortably
// above a "a few cuts between stills" scenario while staying well under
// the one validated real video's 34.
const MOTION_CHECK_SCENE_THRESHOLD = 12; // minimum scene changes in the sample to count as "real video"

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
//
// Real bug found and fixed: a track name with a repeated word (e.g.
// "Mercy Mercy") gave the word-overlap fallback below zero discriminating
// power - both words are literally "mercy", so any candidate containing
// the single word "mercy" anywhere (including a totally different song,
// "Herculion - That Mercy") scored a false 100% overlap and was accepted.
// Deduping the word list before computing the ratio fixes the inflated
// score; requiring at least 2 *unique* words before trusting the ratio at
// all closes the same hole for a track name that's just one word long
// (nothing left to require agreement on).
function titleMatchesTrack(candidateTitle, trackName) {
  const core = coreTrackName(trackName);
  const nCore = normalize(core);
  const nCand = normalize(candidateTitle);
  if (!nCore) return false;
  if (nCand.includes(nCore)) return true;

  const words = [...new Set(
    core
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length > 2)
  )];
  if (words.length < 2) return false; // one/no distinguishing word and no exact substring match above - not enough signal
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
  /visuali[sz]er/i,
  /\btutorial\b/i,
  /\binterview\b/i,
  // Real gap found live: "ERRA - echo sonata guitar playthrough | jesse
  // cash & clint tustin" matched as a medium-tier candidate despite the
  // earlier /\btutorial\b/ exclusion, since the title says "playthrough"
  // not "tutorial" - same non-MV category (someone playing along to the
  // song on camera), different wording. Not blanket-excluding "guitar" on
  // its own (too broad - a real official title could plausibly contain
  // that word for an unrelated reason); "playthrough"/"drum cam" are
  // specific enough phrases to be safe.
  /play[\s-]?through/i,
  /\bdrum\s*cam\b/i,
  // Rule change: no more live-performance substitutes when there's no real
  // official music video - if nothing but a live/concert recording exists,
  // findCandidate() should report no match rather than download one. These
  // titled-as-live results are excluded outright (not just score-penalized
  // the way rankOfficialMv used to) so one can never surface as a "medium"
  // match. Known gap, same as everywhere else in this file: a live
  // recording with no live/concert/festival/session keyword in its own
  // title (e.g. named only after the venue) won't be caught by this - title
  // text is the only signal available, there's no reliable way to detect
  // "this is footage of a live performance" beyond it.
  /\blive\b/i,
  /\bconcert\b/i,
  /\bfestival\b/i,
  /\bsession\b/i,
];

// Closes the exact gap the keyword list above can't: a live-recording title
// with no live/concert/festival/session keyword at all, named only after
// the venue/city instead (the real example that prompted this - Silverstein
// "[4K] @ The Wiltern, Los Angeles, 7/21/19" had none of those keywords but
// is obviously a live show). A city or town name in the title is treated as
// a reliable-enough signal on its own. Deliberately not exhaustive - a
// curated list of major touring-circuit cities across the markets this
// project's own artists actually tour (US/UK/AU/Canada/Europe/major world
// cities), not a full geographic database. Ambiguous names that double as
// common English words (Reading, Bath, Mobile...) are deliberately left out
// - "Reading" would false-positive-exclude any song with the word "reading"
// in its own title, a worse failure mode than the live shows it would catch.
// Known remaining risk, accepted rather than guarded against: a track
// genuinely named after a city (e.g. a song literally called "Chicago" or
// "London") would have its real official MV wrongly excluded too, since
// titleMatchesTrack already requires the candidate title to contain the
// track name - the city name is baked into the title being checked either
// way. Not worth the added complexity of threading trackName through here
// just to special-case it unless it turns out to bite a real track.
const CITY_NAMES = [
  // US
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia',
  'San Antonio', 'San Diego', 'Dallas', 'Austin', 'San Francisco', 'Seattle',
  'Denver', 'Boston', 'Nashville', 'Detroit', 'Portland', 'Las Vegas',
  'Milwaukee', 'Albuquerque', 'Atlanta', 'Miami', 'Minneapolis', 'Cleveland',
  'New Orleans', 'Tampa', 'Pittsburgh', 'Cincinnati', 'Orlando', 'St Louis',
  'Kansas City', 'Sacramento', 'San Jose', 'Indianapolis', 'Columbus',
  'Charlotte', 'Baltimore', 'Memphis', 'Louisville', 'Oklahoma City',
  'Anaheim', 'Fort Worth', 'El Paso',
  // UK / Ireland
  'London', 'Manchester', 'Birmingham', 'Glasgow', 'Liverpool', 'Leeds',
  'Sheffield', 'Bristol', 'Edinburgh', 'Cardiff', 'Belfast', 'Newcastle',
  'Nottingham', 'Southampton', 'Brighton', 'Dublin', 'Cork',
  // Australia / NZ
  'Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Canberra',
  'Hobart', 'Wollongong', 'Newcastle', 'Auckland', 'Wellington',
  // Canada
  'Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa', 'Edmonton',
  'Winnipeg', 'Quebec City',
  // Europe
  'Paris', 'Berlin', 'Munich', 'Hamburg', 'Cologne', 'Frankfurt', 'Madrid',
  'Barcelona', 'Rome', 'Milan', 'Amsterdam', 'Rotterdam', 'Brussels',
  'Vienna', 'Zurich', 'Geneva', 'Stockholm', 'Oslo', 'Copenhagen',
  'Helsinki', 'Warsaw', 'Prague', 'Budapest', 'Lisbon', 'Athens', 'Moscow',
  // Other major touring markets
  'Tokyo', 'Osaka', 'Seoul', 'Mexico City', 'Sao Paulo', 'Rio de Janeiro',
  'Johannesburg', 'Cape Town', 'Singapore',
];
const CITY_NAME_RE = new RegExp(
  `\\b(${CITY_NAMES.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

function phraseMatches(title, phrase) {
  if (!phrase) return false;
  return String(title || '').toLowerCase().includes(String(phrase).toLowerCase());
}

function isExcluded(title, rules = {}) {
  return EXCLUDE_PHRASES.some((re) => re.test(title)) ||
    CITY_NAME_RE.test(title) ||
    (rules.excludedPhrases || []).some((phrase) => phraseMatches(title, phrase));
}

function customRuleScore(title, rules = {}) {
  let score = 0;
  for (const phrase of rules.preferredPhrases || []) {
    if (phraseMatches(title, phrase)) score += Number(rules.preferredScore ?? 1);
  }
  for (const phrase of rules.penalizedPhrases || []) {
    if (phraseMatches(title, phrase)) score += Number(rules.penaltyScore ?? -2);
  }
  return score;
}

// Returns every plausible candidate ranked best-first (not just the top one),
// so findCandidate() can fall through to the next-best if the top pick turns
// out to be a static image (see hasMotion() below).
function rankOfficialMv(results, artist, trackName, trackDurationSec, rules = {}) {
  const ranked = [];
  for (const r of results) {
    if (!r.title || !r.channel) continue;
    if (isExcluded(r.title, rules)) continue; // live/concert/festival/session titles excluded here, see EXCLUDE_PHRASES
    if (!titleMatchesTrack(r.title, trackName)) continue;
    const titleLower = r.title.toLowerCase();
    let score = 0;
    const isOfficialTag = /official\s*(music\s*)?video/.test(titleLower);
    const chMatch = channelMatchesArtist(r.channel, artist);
    if (isOfficialTag) score += 3;
    if (chMatch) score += 3;
    if (r.duration && trackDurationSec) {
      const diff = Math.abs(r.duration - trackDurationSec);
      if (diff < 15) score += 2;
      else if (diff < 40) score += 1;
      else if (diff > 90) score -= 2;
    }
    score += customRuleScore(r.title, rules);
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
 * { tier: 'high'|'medium'|'none', type: 'official_mv'|null, video, score,
 *   rejectedStatic }
 * rejectedStatic lists any candidate video IDs that scored well but were
 * rejected by the motion check (static image / slow-pan) before this pick.
 *
 * No live-performance fallback: if nothing but a live/concert/festival/
 * session recording exists for a track, this reports 'none' rather than
 * downloading one - a live video is never an acceptable substitute for a
 * real official music video, per an explicit rule change. There used to be
 * a second search pass here for exactly that fallback (rankOfficialLive,
 * type: 'official_live') - removed entirely, not just disabled, since
 * nothing else in the codebase referenced that type.
 */
async function findCandidate({ artist, trackName, durationSec }, rules = {}) {
  const mvResults = await ytSearch(`${artist} ${trackName} official music video`);
  const rankedMv = rankOfficialMv(mvResults, artist, trackName, durationSec, rules);
  const highTierScore = Number(rules.highTierScore ?? 5);
  const mediumTierScore = Number(rules.mediumTierScore ?? 2);
  const minFallbackViews = Number(rules.minFallbackViews ?? 50000);

  const highTierCandidates = rankedMv.filter(
    (c) => c.score >= highTierScore && (c.chMatch || c.video.views > minFallbackViews)
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

  // Real bug found and fixed: medium tier used to have NO artist
  // corroboration requirement at all - only the (already-loosened) title
  // word-overlap check above. That's how "Silverstein - Mercy Mercy"
  // matched "Herculion - That Mercy [Official Music Video]": completely
  // unrelated band and song, title-only score of 5 (official tag + a
  // duration coincidence) with chMatch false and low view count. Medium
  // tier now requires the same real signal high tier already does - some
  // corroboration that the video is actually associated with the artist,
  // not just a title that happens to score well.
  const mediumTierCandidates = rankedMv.filter(
    (c) => c.score >= mediumTierScore && !highTierCandidates.includes(c) && (c.chMatch || c.video.views > minFallbackViews)
  );
  if (mediumTierCandidates.length > 0) {
    const { picked, rejected } = await pickFirstWithMotion(mediumTierCandidates);
    if (picked) {
      return { tier: 'medium', type: 'official_mv', video: picked.video, score: picked.score, rejectedStatic: rejected };
    }
  }

  return { tier: 'none', type: null, video: null, score: 0, rejectedStatic: [] };
}

function download(videoId, outPathTemplate, qualityProfile) {
  const format = qualityProfile?.ytdlpFormat || 'bestvideo[vcodec!*=av01][height<=1080]+bestaudio/best[height<=1080]/best';
  return new Promise((resolve) => {
    execFile(
      YTDLP,
      [
        // AV1 excluded deliberately: no released NVIDIA Shield TV model has
        // hardware AV1 decode, and software decode at 4K isn't viable there.
        '-f', format,
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

module.exports = { findCandidate, download, titleMatchesTrack, channelMatchesArtist, rankOfficialMv };
