#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-root-folders-'));

const rootFolders = require('../src/services/rootFolders');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const legacy = rootFolders.saveConfig({
  musicVideosPath: '/media/MusicVideos',
  concertsPath: '/media/Concerts',
});
assert(legacy.musicVideoRootFolders.length === 1, 'legacy musicVideosPath should become one music root');
assert(legacy.concertRootFolders.length === 1, 'legacy concertsPath should become one concert root');
assert(legacy.defaultMusicVideosRootFolderId === legacy.musicVideoRootFolders[0].id, 'default music root should be first root');

const updated = rootFolders.saveConfig({
  musicVideoRootFolders: 'Main | /media/MusicVideos\nOverflow | /bulk/MusicVideos',
  concertRootFolders: 'Concerts | /media/Concerts\nArchive | /bulk/Concerts',
});
assert(updated.musicVideoRootFolders.length === 2, 'two music roots should be saved');
assert(updated.concertRootFolders.length === 2, 'two concert roots should be saved');
assert(updated.musicVideoRootFolders[0].name === 'Main', 'music root name should parse from line prefix');
assert(updated.musicVideoRootFolders[1].path === '/bulk/MusicVideos', 'music root path should parse from second line');
assert(rootFolders.defaultRoot('music').path === '/media/MusicVideos', 'default music root should remain first configured root');
assert(rootFolders.findRoot('music', updated.musicVideoRootFolders[1].id).name === 'Overflow', 'findRoot should resolve configured root id');

require('../src/db').close();
fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
console.log('Root folder tests OK');
