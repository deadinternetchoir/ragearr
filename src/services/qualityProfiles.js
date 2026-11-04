const PROFILES = [
  {
    id: 'balanced_1080p',
    name: 'HD-1080p',
    cutoff: '1080p',
    cutoffHeight: 1080,
    description: 'Prefer the best non-AV1 video at or below 1080p.',
    ytdlpFormat: 'bestvideo[vcodec!*=av01][height<=1080]+bestaudio/best[height<=1080]/best',
  },
  {
    id: 'high_4k',
    name: 'Ultra-HD',
    cutoff: '2160p',
    cutoffHeight: 2160,
    description: 'Allow up to 4K non-AV1 video when available.',
    ytdlpFormat: 'bestvideo[vcodec!*=av01][height<=2160]+bestaudio/bestvideo[vcodec!*=av01]+bestaudio/best',
  },
  {
    id: 'compact_720p',
    name: 'HD-720p',
    cutoff: '720p',
    cutoffHeight: 720,
    description: 'Keep files smaller by capping video at 720p.',
    ytdlpFormat: 'bestvideo[vcodec!*=av01][height<=720]+bestaudio/best[height<=720]/best',
  },
];

const DEFAULT_PROFILE_ID = 'balanced_1080p';

function all() {
  return PROFILES;
}

function get(id) {
  return PROFILES.find((p) => p.id === id) || PROFILES.find((p) => p.id === DEFAULT_PROFILE_ID);
}

function isValid(id) {
  return PROFILES.some((p) => p.id === id);
}

module.exports = { all, get, isValid, DEFAULT_PROFILE_ID };
