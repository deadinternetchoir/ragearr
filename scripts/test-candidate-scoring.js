#!/usr/bin/env node
// Candidate rule normalisation and the search/motion pipeline, using fake
// yt-dlp/ffmpeg binaries (no network, no real tools needed).

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-scoring-'));
process.env.RAGEARR_DATA_DIR = path.join(tmp, 'data');

// Fake yt-dlp: answers the search call with one plausible official video, and
// the storyboard call by writing a minimal .mhtml containing one webp part.
// ffmpeg is deliberately missing, as it can be on a minimal install.
const fakeYtdlp = path.join(tmp, 'fake-yt-dlp');
fs.writeFileSync(
  fakeYtdlp,
  `#!/bin/sh
case "$*" in
  *ytsearch*) printf 'abc123XYZ_-\tTest Artist - Test Song (Official Video)\tTest Artist\t200\t900000\n'; exit 0 ;;
esac
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
printf 'Content-type: image/webp\r\nContent-length: 4\r\nX-Fake: 1\r\n\r\nABCD' > "$out"
`,
  { mode: 0o755 }
);
process.env.YTDLP_PATH = fakeYtdlp;
process.env.FFMPEG_PATH = path.join(tmp, 'no-such-ffmpeg');

const candidateRules = require('../src/services/candidateRules');
const db = require('../src/db');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  // Blank or null numeric fields mean "use the default", not zero. Zero would
  // make highTierScore 0 (everything is high tier) or minFallbackViews 0.
  const blank = candidateRules.normalize({ highTierScore: '', mediumTierScore: '  ', minFallbackViews: null, preferredScore: undefined, penaltyScore: false });
  assert(blank.highTierScore === candidateRules.DEFAULTS.highTierScore, `blank highTierScore became ${blank.highTierScore}`);
  assert(blank.mediumTierScore === candidateRules.DEFAULTS.mediumTierScore, `whitespace mediumTierScore became ${blank.mediumTierScore}`);
  assert(blank.minFallbackViews === candidateRules.DEFAULTS.minFallbackViews, `null minFallbackViews became ${blank.minFallbackViews}`);
  assert(blank.preferredScore === candidateRules.DEFAULTS.preferredScore, 'undefined should use the default');
  assert(blank.penaltyScore === candidateRules.DEFAULTS.penaltyScore, 'boolean should use the default');

  // Real numbers, numeric strings and an explicit zero are still honoured.
  const real = candidateRules.normalize({ highTierScore: '7', mediumTierScore: 0, minFallbackViews: 1000.5, penaltyScore: -3 });
  assert(real.highTierScore === 7 && real.mediumTierScore === 0 && real.minFallbackViews === 1000.5 && real.penaltyScore === -3, 'explicit numbers must be kept');
  assert(candidateRules.normalize({ highTierScore: 'abc' }).highTierScore === candidateRules.DEFAULTS.highTierScore, 'non-numeric text uses the default');

  // Phrase lists accept arrays or newline-separated text and drop blanks.
  const phrases = candidateRules.normalize({ excludedPhrases: ' remix \n\n  slowed ', preferredPhrases: ['  vevo  ', ''] });
  assert(JSON.stringify(phrases.excludedPhrases) === '["remix","slowed"]', 'excluded phrases should be split and trimmed');
  assert(JSON.stringify(phrases.preferredPhrases) === '["vevo"]', 'preferred phrases should be trimmed');

  // docs/static-video-detection.md: the motion check fails open when it cannot
  // run. With ffmpeg unavailable, a well-matched official video must still be
  // offered rather than being rejected as "static".
  const youtube = require('../src/services/youtube');
  const result = await youtube.findCandidate({ artist: 'Test Artist', trackName: 'Test Song', durationSec: 201 }, candidateRules.get());
  assert(result.video && result.video.id === 'abc123XYZ_-', `expected the official video, got tier ${result.tier}`);
  assert(result.tier === 'high', `expected high tier, got ${result.tier}`);
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('Candidate scoring tests OK');
  })
  .catch((e) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(e.message);
    process.exit(1);
  });
