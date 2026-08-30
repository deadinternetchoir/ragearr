// Plex target backend. Talks to a Plex Media Server over its HTTP API.
//
// Note on connectivity: if your Plex server is behind NAT with no direct port
// forward (true of some seedbox/VPS setups), you may need to resolve its
// reachable connection URI via plex.tv's resource discovery
// (GET https://plex.tv/api/v2/resources) rather than assuming localhost or a
// LAN IP works — see docs/plex-notes.md for the pattern this was validated
// against. That connection can be intermittently flaky (transient 401s that
// clear up on retry); the retry wrapper below handles that.

const https = require('https');

function makeClient({ host, port, token }) {
  function requestOnce(reqPath, method, extraHeaders) {
    return new Promise((resolve, reject) => {
      const sep = reqPath.includes('?') ? '&' : '?';
      const opts = {
        hostname: host,
        port,
        path: reqPath + sep + 'X-Plex-Token=' + token,
        method: method || 'GET',
        headers: Object.assign({ Accept: 'application/json' }, extraHeaders || {}),
        rejectUnauthorized: false,
        timeout: 20000,
      };
      const req = https.request(opts, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.end();
    });
  }

  async function request(reqPath, method, extraHeaders, retries = 4) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const res = await requestOnce(reqPath, method, extraHeaders);
        if (res.status === 401 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async function json(reqPath, method, extraHeaders) {
    const res = await request(reqPath, method, extraHeaders);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    }
    return JSON.parse(res.body);
  }

  return {
    request,
    json,

    async refreshSection(sectionKey) {
      // Note: force=1 requires a local/trusted connection and 401s over a
      // remote token-only connection — a plain refresh is sufficient since
      // Plex detects changed file sizes/mtimes on its own.
      return request(`/library/sections/${sectionKey}/refresh`);
    },

    async listSection(sectionKey) {
      return json(`/library/sections/${sectionKey}/all`);
    },

    async getItem(ratingKey) {
      return json(`/library/metadata/${ratingKey}`);
    },

    async createPlaylist({ title, ratingKeys, machineIdentifier }) {
      const uri = `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;
      const params = { type: 'video', title, smart: '0', uri };
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      return json('/playlists?' + qs, 'POST');
    },
  };
}

module.exports = { makeClient };
