#!/usr/bin/env node
// Library path construction must never escape the root folder, whatever an
// import list or a crafted backup puts in the artist/track fields.

const library = require('../src/services/library');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isContained(relPath) {
  return !relPath.startsWith('/') && !relPath.split('/').some((part) => part === '..' || part === '.' || part === '');
}

const hostile = [
  ['..', 'Song'],
  ['.', 'Song'],
  ['...', 'Song'],
  ['../../etc', 'passwd'],
  ['..\\..', 'Song'],
  ['', 'Song'],
  ['???', 'Song'],
  ['/', 'Song'],
  [' . ', 'Song'],
];
for (const [artist, track] of hostile) {
  const rel = library.musicVideoRelativePath(artist, track, 'mkv');
  assert(isContained(rel), `path for artist ${JSON.stringify(artist)} escapes the root: ${rel}`);
  assert(rel.split('/').length === 2, `expected <Artist>/<file>, got ${rel}`);
}

// Ordinary names keep the documented <Artist>/<Artist> - <Track>.<ext> layout.
assert(library.musicVideoRelativePath('AC/DC', 'T.N.T.', 'mkv') === 'ACDC/ACDC - T.N.T..mkv', 'normal names must be unchanged');
assert(library.musicVideoRelativePath('Mr. Mister', 'Kyrie', 'mp4') === 'Mr. Mister/Mr. Mister - Kyrie.mp4', 'dots inside names must be unchanged');

console.log('Path safety tests OK');
