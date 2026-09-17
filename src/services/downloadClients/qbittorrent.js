function cleanBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
  }
  return body;
}

function cookieHeader(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : null;
  const cookies = raw && raw.length ? raw : [headers.get('set-cookie')].filter(Boolean);
  return cookies.map((cookie) => cookie.split(';')[0]).filter(Boolean).join('; ');
}

function makeClient({ baseUrl, username, password, category, savePath }) {
  const root = cleanBaseUrl(baseUrl);
  let cookie = null;

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${root}${path}`, { ...options, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`qBittorrent HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return res;
  }

  async function login() {
    if (cookie) return;
    const res = await fetch(`${root}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ username, password }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok || !/^ok\.?$/i.test(text.trim())) {
      throw new Error(`qBittorrent login failed${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    cookie = cookieHeader(res.headers);
    if (!cookie) throw new Error('qBittorrent login did not return a session cookie');
  }

  return {
    async getVersion() {
      await login();
      return (await request('/api/v2/app/version')).text();
    },

    async addByUrl(url) {
      await login();
      const res = await request('/api/v2/torrents/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ urls: url, category, savepath: savePath }),
      });
      const text = await res.text().catch(() => '');
      if (text && !/^ok\.?$/i.test(text.trim())) throw new Error(`qBittorrent add failed: ${text.slice(0, 300)}`);
      return text || 'Ok.';
    },
  };
}

module.exports = { makeClient };
