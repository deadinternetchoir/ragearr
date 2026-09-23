const settings = require('../settings');
const rtorrent = require('./rtorrent');
const qbittorrent = require('./qbittorrent');
const { sshExec, LOCAL_CONN } = require('../sshExec');

const DEFAULT_TYPE = 'rtorrent';

const TYPES = {
  rtorrent: {
    id: 'rtorrent',
    name: 'rTorrent',
    configKey: 'rtorrent',
    requiredFields: ['host', 'user', 'sshKeyPath', 'socketPath'],
    makeClient: rtorrent.makeClient,
    publicConfig(cfg) {
      return {
        type: 'rtorrent',
        host: cfg.host || '',
        user: cfg.user || '',
        sshKeyPath: cfg.sshKeyPath || '',
        socketPath: cfg.socketPath || '',
      };
    },
    connectionDetails(cfg) {
      return `${cfg.user}@${cfg.host}:${cfg.socketPath}`;
    },
    librarySshConn(cfg) {
      if (!cfg?.host || !cfg?.user || !cfg?.sshKeyPath) return null;
      return { host: cfg.host, user: cfg.user, sshKeyPath: cfg.sshKeyPath };
    },
    async check(cfg) {
      const conn = this.librarySshConn(cfg);
      await sshExec(conn, `test -S '${cfg.socketPath}' && echo ok`, { timeout: 12000 });
      return { message: 'SSH reachable and socket exists', details: this.connectionDetails(cfg) };
    },
  },
  qbittorrent: {
    id: 'qbittorrent',
    name: 'qBittorrent',
    configKey: 'qbittorrent',
    requiredFields: ['baseUrl', 'username', 'password'],
    makeClient: qbittorrent.makeClient,
    storageConfig(cfg, current = {}) {
      return {
        baseUrl: String(cfg.baseUrl || '').replace(/\/+$/, ''),
        username: cfg.username || '',
        password: cfg.password || current.password || '',
        category: cfg.category || '',
        savePath: cfg.savePath || '',
      };
    },
    publicConfig(cfg) {
      return {
        type: 'qbittorrent',
        baseUrl: cfg.baseUrl || '',
        username: cfg.username || '',
        passwordConfigured: Boolean(cfg.password),
        category: cfg.category || '',
        savePath: cfg.savePath || '',
      };
    },
    connectionDetails(cfg) {
      return cfg.baseUrl || null;
    },
    async check(cfg) {
      const client = this.makeClient(cfg);
      const version = await client.getVersion();
      return { message: `Reachable${version ? ` ${version}` : ''}`, details: this.connectionDetails(cfg) };
    },
  },
};

function supportedTypes() {
  return Object.values(TYPES).map(({ id, name, requiredFields }) => ({ id, name, requiredFields }));
}

function activeType() {
  const cfg = settings.get('downloadClient') || {};
  return TYPES[cfg.type] ? cfg.type : DEFAULT_TYPE;
}

function typeConfig(type = activeType()) {
  const spec = TYPES[type];
  if (!spec) return null;
  return settings.get(spec.configKey) || {};
}

function isConfigured(type = activeType(), cfg = typeConfig(type)) {
  const spec = TYPES[type];
  return Boolean(spec && spec.requiredFields.every((field) => cfg?.[field]));
}

function publicConfig(type = activeType()) {
  const spec = TYPES[type] || TYPES[DEFAULT_TYPE];
  const cfg = typeConfig(spec.id);
  return {
    type: spec.id,
    name: spec.name,
    configured: isConfigured(spec.id, cfg),
    supportedTypes: supportedTypes(),
    ...spec.publicConfig(cfg),
  };
}

function setConfig(type, cfg) {
  const spec = TYPES[type];
  if (!spec) throw new Error(`unsupported download client type: ${type}`);
  const current = settings.get(spec.configKey) || {};
  const next = spec.storageConfig ? spec.storageConfig(cfg || {}, current) : spec.publicConfig(cfg || {});
  const missing = spec.requiredFields.filter((field) => !next?.[field]);
  if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`);
  settings.set('downloadClient', { type });
  settings.set(spec.configKey, next);
}

function makeClient(type = activeType()) {
  const spec = TYPES[type];
  const cfg = typeConfig(type);
  if (!spec || !isConfigured(type, cfg)) return null;
  return spec.makeClient(cfg);
}

function librarySshConn() {
  const type = activeType();
  const spec = TYPES[type];
  const cfg = typeConfig(type);
  if (!spec?.librarySshConn || !isConfigured(type, cfg)) return null;
  return spec.librarySshConn(cfg);
}

// The connection library operations should use for a given root folder: a
// root mounted into the container runs its commands locally; anything else
// goes over the download client's SSH connection as before. Returns null when
// a remote root has no SSH connection configured.
function libraryConnForRoot(root) {
  if (root?.local) return LOCAL_CONN;
  return librarySshConn();
}

async function checkActive() {
  const type = activeType();
  const spec = TYPES[type];
  const cfg = typeConfig(type);
  if (!spec || !isConfigured(type, cfg)) {
    return {
      id: 'download_client',
      label: 'Download client',
      status: 'warn',
      message: 'Not configured',
      details: null,
    };
  }
  try {
    const result = await spec.check(cfg);
    return {
      id: 'download_client',
      label: spec.name,
      status: 'ok',
      message: result.message,
      details: result.details,
    };
  } catch (e) {
    return {
      id: 'download_client',
      label: spec.name,
      status: 'fail',
      message: e.message,
      details: spec.connectionDetails ? spec.connectionDetails(cfg) : null,
    };
  }
}

module.exports = {
  DEFAULT_TYPE,
  supportedTypes,
  activeType,
  publicConfig,
  setConfig,
  makeClient,
  librarySshConn,
  libraryConnForRoot,
  checkActive,
};
