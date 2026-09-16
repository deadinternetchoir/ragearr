const fs = require('fs');
const path = require('path');
const { sshExec } = require('./sshExec');

const DATA_DIR = process.env.RAGEARR_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const THUMBNAIL_DIR = path.join(DATA_DIR, 'thumbnails');

function ensureDir() {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

function youtubeThumbnailUrl(videoId) {
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function localThumbnailUrl(trackId) {
  return `/generated-thumbnails/track-${trackId}.jpg`;
}

function localThumbnailPath(trackId) {
  return path.join(THUMBNAIL_DIR, `track-${trackId}.jpg`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function generateRemoteFrame(conn, remoteRoot, relPath, trackId) {
  ensureDir();
  const outPath = localThumbnailPath(trackId);
  const remotePath = `${String(remoteRoot).replace(/\/+$/, '')}/${relPath}`;
  const cmd = [
    'ffmpeg',
    '-hide_banner',
    '-loglevel error',
    '-ss 00:00:10',
    '-i',
    shellQuote(remotePath),
    '-frames:v 1',
    '-vf',
    shellQuote('scale=360:-1'),
    '-f image2pipe',
    '-vcodec mjpeg',
    '-',
    '| base64 -w 0',
  ].join(' ');

  const encoded = (await sshExec(conn, cmd, { timeout: 45000, maxBuffer: 8 * 1024 * 1024 })).trim();
  if (!encoded) throw new Error('ffmpeg did not return a thumbnail frame');
  fs.writeFileSync(outPath, Buffer.from(encoded, 'base64'));
  return localThumbnailUrl(trackId);
}

module.exports = {
  THUMBNAIL_DIR,
  youtubeThumbnailUrl,
  localThumbnailUrl,
  localThumbnailPath,
  generateRemoteFrame,
};
