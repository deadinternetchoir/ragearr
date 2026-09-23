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
assert(updated.musicVideoRootFolders.every((root) => root.local === false), 'roots without the local flag should be remote');

const mixed = rootFolders.saveConfig({
  musicVideoRootFolders: 'Local | /music-videos | local\nRemote | /home/user/MusicVideos\nPiped | /odd|path',
});
assert(mixed.musicVideoRootFolders[0].local === true, '"| local" suffix should mark a root local');
assert(mixed.musicVideoRootFolders[0].path === '/music-videos', 'local flag should not leak into the path');
assert(mixed.musicVideoRootFolders[1].local === false, 'a plain "Name | /path" root should stay remote');
assert(mixed.musicVideoRootFolders[2].path === '/odd|path', 'a pipe inside the path should still be kept');
const reloaded = rootFolders.saveConfig({ musicVideoRootFolders: mixed.musicVideoRootFolders });
assert(reloaded.musicVideoRootFolders[0].local === true, 'local flag should survive an object-form save');
assert(reloaded.musicVideoRootFolders[0].id === mixed.musicVideoRootFolders[0].id, 'root id should be stable across saves');

const downloadClients = require('../src/services/downloadClients');
const { LOCAL_CONN } = require('../src/services/sshExec');
assert(downloadClients.libraryConnForRoot(mixed.musicVideoRootFolders[0]) === LOCAL_CONN, 'a local root should use the local connection');
assert(downloadClients.libraryConnForRoot(mixed.musicVideoRootFolders[1]) === null, 'a remote root with no SSH client configured should have no connection');

require('../src/db').close();
fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
console.log('Root folder tests OK');
