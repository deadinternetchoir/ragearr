#!/usr/bin/env node

// Exercises a locally mounted music-video root end to end: the same scan,
// search, upload and move commands the routes build, run through the local
// connection instead of SSH.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-local-library-'));
process.env.RAGEARR_DATA_DIR = path.join(tmp, 'config');

const library = require('../src/services/library');
const { sshExec, scpUpload, LOCAL_CONN } = require('../src/services/sshExec');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

(async () => {
  const rootPath = path.join(tmp, "Music Videos");
  fs.mkdirSync(path.join(rootPath, 'Sum 41'), { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'Sum 41', 'Sum 41 - In Too Deep.mkv'), 'x');
  fs.writeFileSync(path.join(rootPath, 'Sum 41', 'Sum 41 - In Too Deep.srt'), 'x');
  const root = { id: 'music-local', name: 'Local', path: rootPath, local: true };

  const scan = await library.scanMusicVideos(() => LOCAL_CONN, [root], [{ id: 7, artist: 'Sum 41', track_name: 'In Too Deep' }]);
  assert(scan.files.length === 1, 'scan should list only video files');
  assert(scan.matches.length === 1 && scan.matches[0].trackId === 7, 'scan should match the existing track');
  assert(scan.unmatched.length === 0, 'nothing should be unmatched');

  const found = await library.searchMusicVideoFiles(LOCAL_CONN, [root], 'too deep');
  assert(found.length === 1 && found[0].filePath === 'Sum 41/Sum 41 - In Too Deep.mkv', 'search should accept a plain connection too');

  // download import: mkdir + copy, as the track_download job does
  const src = path.join(tmp, 'dl.mkv');
  fs.writeFileSync(src, 'video');
  const relPath = library.musicVideoRelativePath("Guns N' Roses", 'Patience', 'mkv');
  const destDir = `${rootPath}/${relPath.slice(0, relPath.lastIndexOf('/'))}`;
  await sshExec(LOCAL_CONN, `mkdir -p ${shellQuote(destDir)}`);
  await scpUpload(LOCAL_CONN, src, `${rootPath}/${relPath}`);
  assert(fs.readFileSync(path.join(rootPath, relPath), 'utf8') === 'video', 'upload should copy the file into the local root');
  assert(fs.existsSync(src), 'upload should copy, not move, the temp download');

  // ownership is a no-op without RAGEARR_LOCAL_UID, and never touches remote conns
  await library.applyLocalOwnership(LOCAL_CONN, { dirs: [destDir], files: [`${rootPath}/${relPath}`] });
  await library.applyLocalOwnership({ host: 'example.invalid', user: 'x', sshKeyPath: '/nope' }, { files: ['/nope'] });
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    process.env.RAGEARR_LOCAL_UID = String(process.getuid());
    process.env.RAGEARR_LOCAL_GID = String(process.getgid());
    await library.applyLocalOwnership(LOCAL_CONN, { dirs: [destDir], files: [`${rootPath}/${relPath}`] });
    const mode = fs.statSync(path.join(rootPath, relPath)).mode & 0o777;
    assert(mode === 0o664, `local ownership should set file mode 664 (got ${mode.toString(8)})`);
  }

  let failed = false;
  try {
    await sshExec(LOCAL_CONN, `test -f ${shellQuote(`${rootPath}/missing.mkv`)}`);
  } catch {
    failed = true;
  }
  assert(failed, 'a failing local command should reject');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Local library tests OK');
})().catch((e) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
