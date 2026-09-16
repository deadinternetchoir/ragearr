const settings = require('./settings');

const DEFAULTS = {
  preferredPhrases: ['official music video', 'official video'],
  penalizedPhrases: [],
  excludedPhrases: [],
  preferredScore: 1,
  penaltyScore: -2,
  highTierScore: 5,
  mediumTierScore: 2,
  minFallbackViews: 50000,
};

function lines(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function numberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalize(raw = {}) {
  return {
    preferredPhrases: lines(raw.preferredPhrases),
    penalizedPhrases: lines(raw.penalizedPhrases),
    excludedPhrases: lines(raw.excludedPhrases),
    preferredScore: numberOrDefault(raw.preferredScore, DEFAULTS.preferredScore),
    penaltyScore: numberOrDefault(raw.penaltyScore, DEFAULTS.penaltyScore),
    highTierScore: numberOrDefault(raw.highTierScore, DEFAULTS.highTierScore),
    mediumTierScore: numberOrDefault(raw.mediumTierScore, DEFAULTS.mediumTierScore),
    minFallbackViews: numberOrDefault(raw.minFallbackViews, DEFAULTS.minFallbackViews),
  };
}

function get() {
  return normalize({ ...DEFAULTS, ...(settings.get('candidateRules') || {}) });
}

function set(next) {
  const normalized = normalize({ ...DEFAULTS, ...next });
  settings.set('candidateRules', normalized);
  return normalized;
}

module.exports = { DEFAULTS, get, set, normalize };
