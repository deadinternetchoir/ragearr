#!/usr/bin/env node

const importLists = require('../src/services/importLists');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(actual, expected, message) {
  assert(actual === expected, `${message}: expected "${expected}", got "${actual}"`);
}

const parsed = importLists.parseYouTubeTitle('Silverstein - Drain The Blood (Official Music Video)', 'Silverstein');
same(parsed.artist, 'Silverstein', 'artist parsed from dashed title');
same(parsed.track_name, 'Drain The Blood', 'track parsed from dashed title');

const topic = importLists.parseYouTubeTitle('Misery Business', 'Paramore - Topic');
same(topic.artist, 'Paramore', 'topic uploader cleaned');
same(topic.track_name, 'Misery Business', 'track parsed from plain title');

assert(importLists.isYouTubePlaylistUrl('https://www.youtube.com/playlist?list=PL123'), 'youtube playlist URL not detected');
assert(importLists.isYouTubePlaylistUrl('https://www.youtube.com/watch?v=abc&list=PL123'), 'youtube watch/list URL not detected');
assert(!importLists.isYouTubePlaylistUrl('https://example.com/music.csv'), 'non-youtube URL misdetected');
assert(importLists.isSpotifyPlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), 'spotify playlist URL not detected');
assert(!importLists.isSpotifyPlaylistUrl('https://open.spotify.com/track/123'), 'spotify track URL misdetected as playlist');

const rows = importLists.rowsFromYouTubePlaylistData({
  entries: [
    { id: 'abc123', title: 'Thursday - Understanding In A Car Crash [Official Video]', duration: 264 },
    { id: 'skipme', title: '[Deleted video]' },
    { id: 'def456', title: 'Drain The Blood', uploader: 'Silverstein - Topic', duration: '181' },
  ],
});
same(rows.length, 2, 'deleted videos skipped');
same(rows[0].artist, 'Thursday', 'playlist row artist parsed');
same(rows[0].track_name, 'Understanding In A Car Crash', 'playlist row track parsed');
same(rows[0].duration_sec, 264, 'numeric duration preserved');
same(rows[0].source_uri, 'https://www.youtube.com/watch?v=abc123', 'source URL derived');
same(rows[1].artist, 'Silverstein', 'topic uploader fallback artist parsed');
same(rows[1].duration_sec, 181, 'string duration parsed');

const spotifyRows = importLists.parseText(
  'Track Name,Artist Name(s),Album Name,Duration (ms),Track URI\n' +
  'Drain The Blood,Silverstein,Antibloom,181000,spotify:track:abc123\n' +
  'Understanding In A Car Crash,Thursday,Full Collapse,264000,https://open.spotify.com/track/def456'
);
same(spotifyRows.length, 2, 'spotify export rows parsed');
same(spotifyRows[0].artist, 'Silverstein', 'spotify artist parsed');
same(spotifyRows[0].track_name, 'Drain The Blood', 'spotify track parsed');
same(spotifyRows[0].album, 'Antibloom', 'spotify album parsed');
same(spotifyRows[0].duration_sec, 181, 'spotify duration ms parsed');
same(spotifyRows[0].source_uri, 'spotify:track:abc123', 'spotify source uri parsed');
same(importLists.sourceTypeFromRows(spotifyRows), 'spotify_export', 'spotify source type detected');

console.log('Import-list tests OK');
