#!/usr/bin/env node
// Import-list edge cases not covered by test-import-lists.js. URL fetching is
// tested against a throwaway server on loopback; nothing leaves the machine.

const http = require('http');
const importLists = require('../src/services/importLists');
const spotify = require('../src/services/spotify');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// BOM, CRLF and header aliases (Exportify-style).
const bom = '﻿Track Name,Artist Name(s),Album Name,Track Duration (ms)\r\nSong One,"Band, The",Album,215000\r\n';
let rows = importLists.parseText(bom);
assert(rows.length === 1, `BOM + CRLF header should parse one row, got ${rows.length}`);
assert(rows[0].artist === 'Band, The' && rows[0].track_name === 'Song One', 'quoted comma stays inside the artist');
assert(Math.round(rows[0].duration_sec) === 215, 'duration_ms column is converted to seconds');

// Escaped quotes, empty cells, short rows.
rows = importLists.parseText('artist,title\n"The ""Quoted"" One",Track\nOnlyArtist\n,NoArtist\n');
assert(rows.length === 1 && rows[0].artist === 'The "Quoted" One', 'escaped quotes are unescaped; incomplete rows are skipped');

// Tab-separated and plain "Artist - Track" lines.
rows = importLists.parseText('Artist A\tTrack A\tAlbum\t3:15\nArtist B - Track B\n');
assert(rows.length === 2, 'tab and dash formats both parse');
assert(rows[0].duration_sec === 195, 'm:ss durations parse');
assert(rows[1].artist === 'Artist B' && rows[1].track_name === 'Track B', 'dash format splits on " - "');

// Nothing useful in, nothing out; header-only is empty rather than an error.
assert(importLists.parseText('').length === 0, 'empty input');
assert(importLists.parseText('artist,track\n').length === 0, 'header only');
assert(importLists.parseText(null).length === 0, 'null input');

// Duplicate keys ignore case and surrounding space.
assert(importLists.keyFor({ artist: ' ABBA ', track_name: 'Waterloo' }) === importLists.keyFor({ artist: 'abba', track_name: ' waterloo' }), 'keyFor normalises case and space');

// URL recognition: lookalike hosts must not be treated as YouTube/Spotify.
assert(!importLists.isYouTubePlaylistUrl('https://youtube.com.evil.test/playlist?list=x'), 'lookalike YouTube host');
assert(!importLists.isYouTubePlaylistUrl('https://evil.test/watch?list=x'), 'other host with list param');
assert(importLists.isYouTubePlaylistUrl('https://www.youtube.com/playlist?list=PLx'), 'real YouTube playlist');
assert(!importLists.isSpotifyPlaylistUrl('https://open.spotify.com.evil.test/playlist/abc'), 'lookalike Spotify host');
assert(spotify.playlistIdFromUrl('https://open.spotify.com/playlist/abc123?si=zzz') === 'abc123', 'playlist id extraction');
assert(spotify.playlistIdFromUrl('https://open.spotify.com/track/abc123') === null, 'track URL is not a playlist');
assert(spotify.playlistIdFromUrl('not a url') === null, 'garbage URL');

// Spotify items can be null, podcast episodes, or have no artists.
const items = [
  null,
  { track: null },
  { track: { type: 'episode', name: 'Pod', artists: [] } },
  { track: { type: 'track', name: 'No Artist', artists: [] } },
  { track: { type: 'track', name: 'Good', artists: [{ name: 'A' }, { name: 'B' }], album: { name: 'Al' }, duration_ms: 1500, uri: 'spotify:track:1' } },
];
const spotifyRows = spotify.rowsFromPlaylistItems(items);
assert(spotifyRows.length === 1 && spotifyRows[0].artist === 'A, B' && spotifyRows[0].duration_sec === 1.5, 'only complete track items become rows');

async function fetchTests() {
  const big = Buffer.alloc(1024 * 1024 + 10, 'a');
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') return res.end('Artist - Track\n');
    if (req.url === '/big') return res.end(big);
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/' });
      return res.end();
    }
    res.statusCode = 404;
    res.end('secret body that must not be echoed');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert((await importLists.fetchText(`${base}/ok`, { allowLoopback: true })).includes('Artist - Track'), 'plain fetch works');
    const err = async (url) => importLists.fetchText(url, { allowLoopback: true }).then(() => null, (e) => e.message);
    assert(/larger than 1MB/.test(await err(`${base}/big`)), 'oversized responses are cut off');
    const notFound = await err(`${base}/missing`);
    assert(/HTTP 404/.test(notFound) && !/secret/.test(notFound), 'error responses do not echo the body');
    assert(/HTTP 302/.test(await err(`${base}/redirect`)), 'redirects are not followed');
    assert(/http/.test(await err('file:///etc/passwd')), 'file: URLs are refused');
    assert(/invalid URL/.test(await err('not a url')), 'garbage URLs are refused');
  } finally {
    server.close();
  }
}

fetchTests()
  .then(() => console.log('Import edge-case tests OK'))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
