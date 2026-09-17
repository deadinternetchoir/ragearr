#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-download-clients-'));

const db = require('../src/db');
const downloadClients = require('../src/services/downloadClients');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function main() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === '/api/v2/auth/login') {
      const form = new URLSearchParams(body);
      assert(form.get('username') === 'ragearr', 'qBittorrent login username should be posted');
      assert(form.get('password') === 'secret password', 'qBittorrent login password should be posted');
      res.setHeader('Set-Cookie', 'SID=test-session; HttpOnly; path=/');
      res.end('Ok.');
      return;
    }
    if (req.url === '/api/v2/app/version') {
      assert(req.headers.cookie === 'SID=test-session', 'version request should include qBittorrent session cookie');
      res.end('v5.0.0');
      return;
    }
    if (req.url === '/api/v2/torrents/add') {
      assert(req.headers.cookie === 'SID=test-session', 'add request should include qBittorrent session cookie');
      const form = new URLSearchParams(body);
      assert(form.get('urls') === 'magnet:?xt=urn:btih:abc123', 'add request should include torrent URL');
      assert(form.get('category') === 'ragearr', 'add request should include category');
      assert(form.get('savepath') === '/downloads/music-videos', 'add request should include save path');
      res.end('Ok.');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    assert(downloadClients.supportedTypes().some((type) => type.id === 'qbittorrent'), 'qBittorrent should be a supported type');
    downloadClients.setConfig('qbittorrent', {
      baseUrl: `${baseUrl}/`,
      username: 'ragearr',
      password: 'secret password',
      category: 'ragearr',
      savePath: '/downloads/music-videos',
    });

    let cfg = downloadClients.publicConfig();
    assert(cfg.type === 'qbittorrent', 'active type should be qBittorrent');
    assert(cfg.configured === true, 'qBittorrent should be configured');
    assert(cfg.baseUrl === baseUrl, 'baseUrl should be normalized');
    assert(cfg.passwordConfigured === true, 'public config should report configured password');
    assert(!Object.prototype.hasOwnProperty.call(cfg, 'password'), 'public config should not expose qBittorrent password');
    assert(downloadClients.librarySshConn() === null, 'qBittorrent should not provide a library SSH connection');

    downloadClients.setConfig('qbittorrent', {
      baseUrl,
      username: 'ragearr',
      password: '',
      category: 'ragearr',
      savePath: '/downloads/music-videos',
    });
    cfg = downloadClients.publicConfig();
    assert(cfg.passwordConfigured === true, 'blank password update should keep existing qBittorrent password');

    const health = await downloadClients.checkActive();
    assert(health.status === 'ok', 'qBittorrent health check should pass');
    assert(/v5\.0\.0/.test(health.message), 'qBittorrent health should include version');

    const client = downloadClients.makeClient();
    await client.addByUrl('magnet:?xt=urn:btih:abc123');
    assert(requests.some((req) => req.url === '/api/v2/torrents/add'), 'addByUrl should call qBittorrent torrents/add');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('Download-client tests OK'))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
