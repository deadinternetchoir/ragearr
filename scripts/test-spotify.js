#!/usr/bin/env node

const spotify = require('../src/services/spotify');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  spotify.playlistIdFromUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc') === '37i9dQZF1DXcBWIGoYBM5M',
  'playlist URL id parsing failed'
);

const rows = spotify.rowsFromPlaylistItems([
  {
    track: {
      type: 'track',
      name: 'Drain The Blood',
      artists: [{ name: 'Silverstein' }, { name: 'Dayseeker' }],
      album: { name: 'Antibloom' },
      duration_ms: 181000,
      uri: 'spotify:track:abc123',
      external_urls: { spotify: 'https://open.spotify.com/track/abc123' },
    },
  },
  { track: { type: 'episode', name: 'Podcast Thing' } },
]);

assert(rows.length === 1, 'should only import Spotify track items');
assert(rows[0].artist === 'Silverstein, Dayseeker', 'artist names should be joined');
assert(rows[0].track_name === 'Drain The Blood', 'track name mismatch');
assert(rows[0].album === 'Antibloom', 'album mismatch');
assert(rows[0].duration_sec === 181, 'duration should convert ms to seconds');
assert(rows[0].source_uri === 'spotify:track:abc123', 'source uri mismatch');

console.log('Spotify tests OK');
