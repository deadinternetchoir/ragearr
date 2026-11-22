// Small Plex Media Server client: just what the playlist/collection sync needs.
// The Plex token is read from the RAGEARR_PLEX_TOKEN environment variable (a protected env
// file on the server). It is never saved in the database, returned by the API or logged.
const settings = require('./settings');

const PAGE = 500;
const TIMEOUT_MS = 20000;

function getConfig() {
  const cfg = settings.get('plex') || {};
  return {
    baseUrl: String(process.env.RAGEARR_PLEX_URL || cfg.baseUrl || '').trim().replace(/\/+$/, ''),
    tokenSet: Boolean(process.env.RAGEARR_PLEX_TOKEN),
    videoSectionKey: cfg.videoSectionKey ? String(cfg.videoSectionKey) : '',
    enabled: cfg.enabled === true,
    intervalMinutes: Math.min(1440, Math.max(5, parseInt(cfg.intervalMinutes, 10) || 15)),
  };
}

function setConfig(body = {}) {
  const current = settings.get('plex') || {};
  const next = { ...current };
  if (body.baseUrl !== undefined) {
    const url = String(body.baseUrl || '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error('baseUrl must start with http:// or https://');
    next.baseUrl = url;
  }
  if (body.videoSectionKey !== undefined) next.videoSectionKey = String(body.videoSectionKey || '');
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
  if (body.intervalMinutes !== undefined) next.intervalMinutes = Math.min(1440, Math.max(5, parseInt(body.intervalMinutes, 10) || 15));
  settings.set('plex', next);
  return getConfig();
}

class PlexError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createClient({ baseUrl, token, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new PlexError('Plex address is not set');
  if (!token) throw new PlexError('RAGEARR_PLEX_TOKEN is not set in the environment');

  async function request(method, path, { query } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new PlexError(`Plex ${method} ${path} returned ${res.status}`, res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async function paged(path, query, pick) {
    const out = [];
    for (let start = 0; ; start += PAGE) {
      const data = await request('GET', path, {
        query: { ...query, 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(PAGE) },
      });
      const container = data.MediaContainer || {};
      const items = pick(container) || [];
      out.push(...items);
      const total = Number(container.totalSize ?? container.size ?? 0);
      if (items.length < PAGE || out.length >= total) break;
    }
    return out;
  }

  let machineId = null;
  async function machineIdentifier() {
    if (!machineId) machineId = (await request('GET', '/')).MediaContainer?.machineIdentifier;
    if (!machineId) throw new PlexError('Plex did not report a machine identifier');
    return machineId;
  }
  const uriFor = async (ids) => `server://${await machineIdentifier()}/com.plexapp.plugins.library/library/metadata/${ids.join(',')}`;

  return {
    async identity() {
      const c = (await request('GET', '/')).MediaContainer || {};
      return { name: c.friendlyName, version: c.version, machineIdentifier: c.machineIdentifier };
    },
    async sections() {
      const data = await request('GET', '/library/sections');
      return (data.MediaContainer?.Directory || []).map((d) => ({ key: String(d.key), title: d.title, type: d.type }));
    },
    async audioPlaylists() {
      const data = await request('GET', '/playlists', { query: { playlistType: 'audio' } });
      return (data.MediaContainer?.Metadata || []).map((p) => ({
        key: String(p.ratingKey),
        title: p.title,
        smart: Boolean(p.smart),
        count: p.leafCount ?? 0,
      }));
    },
    async playlistItems(key) {
      const items = await paged(`/playlists/${encodeURIComponent(key)}/items`, {}, (c) => c.Metadata);
      return items.map((m) => ({
        ratingKey: String(m.ratingKey),
        title: m.title,
        artist: m.originalTitle || m.grandparentTitle || '',
        albumArtist: m.grandparentTitle || '',
        album: m.parentTitle || null,
        durationSec: m.duration ? m.duration / 1000 : null,
      }));
    },
    // true / false only for a definite answer: a 404 means Plex no longer has the song.
    // Any other failure throws, so an outage is never read as "deleted".
    async songExists(ratingKey) {
      try {
        const data = await request('GET', `/library/metadata/${encodeURIComponent(ratingKey)}`);
        return (data.MediaContainer?.Metadata || []).length > 0;
      } catch (e) {
        if (e.status === 404) return false;
        throw e;
      }
    },
    async findSong(musicSectionKey, title) {
      const items = await paged(`/library/sections/${encodeURIComponent(musicSectionKey)}/all`, { type: '10', title }, (c) => c.Metadata);
      return items.map((m) => ({ ratingKey: String(m.ratingKey), title: m.title, artist: m.originalTitle || '', albumArtist: m.grandparentTitle || '' }));
    },
    async videoItems(sectionKey) {
      const items = await paged(`/library/sections/${encodeURIComponent(sectionKey)}/all`, {}, (c) => c.Metadata);
      return items.map((m) => ({
        ratingKey: String(m.ratingKey),
        title: m.title,
        files: (m.Media || []).flatMap((media) => (media.Part || []).map((part) => part.file)).filter(Boolean),
      }));
    },
    async refreshSection(sectionKey) {
      await request('GET', `/library/sections/${encodeURIComponent(sectionKey)}/refresh`);
    },
    async collections(sectionKey) {
      const data = await request('GET', `/library/sections/${encodeURIComponent(sectionKey)}/collections`);
      return (data.MediaContainer?.Metadata || []).map((c) => ({ key: String(c.ratingKey), title: c.title }));
    },
    async collectionItems(key) {
      const items = await paged(`/library/collections/${encodeURIComponent(key)}/children`, {}, (c) => c.Metadata);
      return items.map((m) => String(m.ratingKey));
    },
    async createCollection(sectionKey, title, ratingKeys) {
      const data = await request('POST', '/library/collections', {
        query: { type: '1', title, smart: '0', sectionId: String(sectionKey), uri: await uriFor(ratingKeys) },
      });
      return String(data.MediaContainer?.Metadata?.[0]?.ratingKey || '');
    },
    async addToCollection(key, ratingKeys) {
      await request('PUT', `/library/collections/${encodeURIComponent(key)}/items`, { query: { uri: await uriFor(ratingKeys) } });
    },
    async removeFromCollection(key, ratingKey) {
      await request('DELETE', `/library/collections/${encodeURIComponent(key)}/items/${encodeURIComponent(ratingKey)}`);
    },
  };
}

function clientFromSettings() {
  const cfg = getConfig();
  return createClient({ baseUrl: cfg.baseUrl, token: process.env.RAGEARR_PLEX_TOKEN });
}

module.exports = { getConfig, setConfig, createClient, clientFromSettings, PlexError };
