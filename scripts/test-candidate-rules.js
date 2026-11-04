#!/usr/bin/env node

const youtube = require('../src/services/youtube');
const candidateRules = require('../src/services/candidateRules');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const results = [
  { id: 'a', title: 'Test Artist - Test Song fan made official video', channel: 'Test Artist', duration: 180, views: 1000 },
  { id: 'b', title: 'Test Artist - Test Song official music video', channel: 'Other Channel', duration: 180, views: 1000 },
  { id: 'c', title: 'Test Artist - Test Song remix official music video', channel: 'Test Artist', duration: 180, views: 1000 },
];

const ranked = youtube.rankOfficialMv(results, 'Test Artist', 'Test Song', 180, {
  preferredPhrases: ['official music video'],
  penalizedPhrases: ['fan made'],
  excludedPhrases: ['remix'],
  preferredScore: 2,
  penaltyScore: -4,
});

assert(ranked.length === 2, 'excluded phrase should remove matching candidate');
assert(ranked[0].video.id === 'b', 'preferred phrase should outrank penalized candidate');
assert(ranked[1].video.id === 'a', 'penalized candidate should remain but rank lower');

const normalized = candidateRules.normalize({
  preferredPhrases: 'one\ntwo\n',
  penalizedPhrases: ['three', ''],
  excludedPhrases: 'four',
  preferredScore: '3',
});
assert(normalized.preferredPhrases.length === 2, 'preferred phrases should normalize from text');
assert(normalized.penalizedPhrases.length === 1, 'penalized phrases should normalize from array');
assert(normalized.excludedPhrases[0] === 'four', 'excluded phrase should normalize');
assert(normalized.preferredScore === 3, 'numeric settings should normalize');

console.log('Candidate-rule tests OK');

// --- 2026-11 matching fixes (MC Thunder II, audio-only, tiebreak) ---
{
  const yt = require('../src/services/youtube');
  const assertOk = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
  assertOk(!yt.titleMatchesTrack('Electric Callboy - MC Thunder II (Dancing Like a Ninja) OFFICIAL VIDEO', 'MC Thunder'), 'sequel "MC Thunder II" must not match "MC Thunder"');
  assertOk(yt.titleMatchesTrack('ELECTRIC CALLBOY - MC Thunder (OFFICIAL VIDEO)', 'MC Thunder'), 'original MC Thunder matches');
  assertOk(yt.titleMatchesTrack('Electric Callboy - MC Thunder II (Dancing Like a Ninja)', 'MC Thunder II'), 'numbered track still matches itself');
  assertOk(yt.isExcluded("The Lonely Island - I'm So Humble (feat. Adam Levine) - [AUDIO ONLY]", {}, { artist: 'The Lonely Island', trackName: "I'm So Humble" }), 'audio only excluded');
  const r = yt.rankOfficialMv([
    { id: 'a', title: 'Money', channel: 'Poppy', duration: 191, views: 1290977 },
    { id: 'b', title: 'That Poppy - Money [Official Video]', channel: 'wannermusic', duration: 191, views: 928311 },
  ], 'That Poppy', 'Money', 191, {});
  assertOk(r[0].video.id === 'b', 'tagged official video wins an equal-score tie');
  console.log('matching-fix checks passed');
}
{
  const yt = require('../src/services/youtube');
  const bad = (m) => { console.error('FAIL: ' + m); process.exit(1); };
  if (yt.titleMatchesTrack('Poppy - BLOODMONEY (Official Music Video)', 'Money')) bad('"Money" must not match inside BLOODMONEY');
  if (!yt.titleMatchesTrack('That Poppy - Money [Official Video]', 'Money')) bad('whole-word Money matches');
  if (!yt.titleMatchesTrack('Go Kindergarten (feat. Robyn & Sean Combs & Paul Rudd)', 'Go Kindergarten')) bad('feat. title still matches');
  if (!yt.isExcluded("01. I'm So Humble (feat. Adam Levine) - Popstar", {}, { artist: 'The Lonely Island', trackName: "I'm So Humble" })) bad('"01." album rip excluded');
  console.log('whole-word and album-rip checks passed');
}
