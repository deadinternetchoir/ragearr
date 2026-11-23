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

const embed = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { state: { data: { entity: { trackList: [
    { uri: 'spotify:track:a1', title: 'Alter Ego (with JT)', subtitle: 'Doechii,\u00a0JT', duration: 204094, entityType: 'track' },
    { uri: 'spotify:episode:e1', title: 'Podcast', subtitle: 'Host', entityType: 'episode' },
    { uri: 'spotify:track:a2', title: '', subtitle: 'Nobody', entityType: 'track' },
  ] } } } } },
})}</script></html>`;
const embedRows = spotify.rowsFromEmbedHtml(embed);
assert(embedRows.length === 1, 'embed parsing should keep only complete tracks');
assert(embedRows[0].artist === 'Doechii, JT', 'embed artist should have a normal space');
assert(embedRows[0].duration_sec > 204 && embedRows[0].source_uri === 'spotify:track:a1', 'embed duration and uri');
assert(spotify.rowsFromEmbedHtml('<html></html>').length === 0, 'page without data gives no rows');
assert(spotify.rowsFromEmbedHtml('<script id="__NEXT_DATA__">{bad</script>').length === 0, 'bad JSON gives no rows');

console.log('Spotify tests OK');
