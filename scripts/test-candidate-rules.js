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
