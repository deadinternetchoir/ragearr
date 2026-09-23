const crypto = require('crypto');
const settings = require('./settings');

function cleanPath(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function idFor(kind, pathValue) {
  const hash = crypto.createHash('sha1').update(`${kind}:${cleanPath(pathValue)}`).digest('hex').slice(0, 10);
  return `${kind}-${hash}`;
}

// A root folder is either on the host reached over the download client's SSH
// connection (the default), or mounted straight into this container - marked
// with a trailing "| local" in the one-per-line settings format.
const LOCAL_FLAG = 'local';

function normalizeLine(kind, line, existingByPath) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const parts = raw.split('|');
  let local = false;
  if (parts.length >= 3 && parts[parts.length - 1].trim().toLowerCase() === LOCAL_FLAG) {
    parts.pop();
    local = true;
  }
  const pathValue = cleanPath(parts.length > 1 ? parts.slice(1).join('|') : parts[0]);
  if (!pathValue) return null;
  const label = parts.length > 1 ? parts[0].trim() : '';
  const existing = existingByPath.get(pathValue);
  return {
    id: existing?.id || idFor(kind, pathValue),
    name: label || existing?.name || pathValue.split('/').filter(Boolean).pop() || pathValue,
    path: pathValue,
    local,
  };
}

function normalizeList(kind, value, legacyPath, currentList = []) {
  const previous = Array.isArray(currentList) ? currentList : [];
  const existingByPath = new Map(previous.map((root) => [cleanPath(root.path), root]));
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/)
      : legacyPath
        ? [legacyPath]
        : [];

  const seen = new Set();
  const roots = [];
  for (const item of source) {
    const root = typeof item === 'object' && item
      ? {
          id: item.id || existingByPath.get(cleanPath(item.path))?.id || idFor(kind, item.path),
          name: String(item.name || existingByPath.get(cleanPath(item.path))?.name || cleanPath(item.path).split('/').filter(Boolean).pop() || item.path).trim(),
          path: cleanPath(item.path),
          local: Boolean(item.local),
        }
      : normalizeLine(kind, item, existingByPath);
    if (!root?.path || seen.has(root.path)) continue;
    seen.add(root.path);
    roots.push(root);
  }
  return roots;
}

function normalizeConfig(raw = {}) {
  const musicVideoRootFolders = normalizeList('music', raw.musicVideoRootFolders, raw.musicVideosPath, raw.musicVideoRootFolders);
  const concertRootFolders = normalizeList('concert', raw.concertRootFolders, raw.concertsPath, raw.concertRootFolders);
  const defaultMusicVideosRootFolderId = musicVideoRootFolders.some((root) => root.id === raw.defaultMusicVideosRootFolderId)
    ? raw.defaultMusicVideosRootFolderId
    : musicVideoRootFolders[0]?.id || null;
  const defaultConcertRootFolderId = concertRootFolders.some((root) => root.id === raw.defaultConcertRootFolderId)
    ? raw.defaultConcertRootFolderId
    : concertRootFolders[0]?.id || null;
  return {
    musicVideosPath: musicVideoRootFolders[0]?.path || '',
    concertsPath: concertRootFolders[0]?.path || '',
    musicVideoRootFolders,
    concertRootFolders,
    defaultMusicVideosRootFolderId,
    defaultConcertRootFolderId,
  };
}

function getConfig() {
  return normalizeConfig(settings.get('library') || {});
}

function saveConfig(input) {
  const current = getConfig();
  const nextInput = { ...current, ...input };
  if (Object.prototype.hasOwnProperty.call(input, 'musicVideoRootFolders')) {
    nextInput.musicVideoRootFolders = input.musicVideoRootFolders;
  } else if (Object.prototype.hasOwnProperty.call(input, 'musicVideosPath')) {
    nextInput.musicVideoRootFolders = input.musicVideosPath;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'concertRootFolders')) {
    nextInput.concertRootFolders = input.concertRootFolders;
  } else if (Object.prototype.hasOwnProperty.call(input, 'concertsPath')) {
    nextInput.concertRootFolders = input.concertsPath;
  }
  const next = normalizeConfig(nextInput);
  settings.set('library', next);
  return next;
}

function roots(kind) {
  const cfg = getConfig();
  return kind === 'concerts' ? cfg.concertRootFolders : cfg.musicVideoRootFolders;
}

function defaultRoot(kind) {
  const cfg = getConfig();
  const list = kind === 'concerts' ? cfg.concertRootFolders : cfg.musicVideoRootFolders;
  const id = kind === 'concerts' ? cfg.defaultConcertRootFolderId : cfg.defaultMusicVideosRootFolderId;
  return list.find((root) => root.id === id) || list[0] || null;
}

function findRoot(kind, id) {
  const list = roots(kind);
  return list.find((root) => root.id === id) || defaultRoot(kind);
}

function rootForStored(kind, id) {
  return findRoot(kind, id);
}

module.exports = {
  getConfig,
  saveConfig,
  roots,
  defaultRoot,
  findRoot,
  rootForStored,
};
