#!/usr/bin/env node
// Black-box auth/role checks: starts the real server on a temp data dir with a
// fake API key and talks to it over loopback HTTP. No external services.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const API_KEY = 'test-only-fake-api-key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-auth-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), RAGEARR_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
  return { child, base: `http://127.0.0.1:${port}/api` };
}

async function call(base, method, route, { headers = {}, body } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, data };
}

async function main() {
  const { child, base } = await startServer({ RAGEARR_API_KEY: API_KEY });
  try {
    const admin = { 'X-Api-Key': API_KEY };

    // --- Authentication basics ---
    assert((await call(base, 'GET', '/tracks')).status === 401, 'no credentials should be 401');
    assert((await call(base, 'GET', '/tracks', { headers: { 'X-Api-Key': 'wrong' } })).status === 401, 'wrong key should be 401');
    assert((await call(base, 'GET', '/tracks', { headers: { 'X-Api-Key': `${API_KEY}x` } })).status === 401, 'longer key should be 401');
    assert((await call(base, 'GET', '/tracks', { headers: { 'X-Api-Key': API_KEY.slice(0, -1) } })).status === 401, 'shorter key should be 401');
    assert((await call(base, 'GET', '/tracks', { headers: admin })).status === 200, 'right key should be 200');
    assert((await call(base, 'GET', '/tracks', { headers: { Authorization: `Bearer ${API_KEY}` } })).status === 200, 'bearer key should be 200');

    // --- Users and sessions ---
    assert((await call(base, 'POST', '/users', { headers: admin, body: { username: 'boss', password: 'boss password', role: 'admin' } })).status === 201, 'create admin');
    assert((await call(base, 'POST', '/users', { headers: admin, body: { username: 'viewer', password: 'viewer password', role: 'user' } })).status === 201, 'create user');
    const login = await call(base, 'POST', '/auth/login', { body: { username: 'viewer', password: 'viewer password' } });
    assert(login.status === 200 && login.data.token, 'user login');
    const user = { 'X-Session-Token': login.data.token };
    assert((await call(base, 'GET', '/tracks', { headers: user })).status === 200, 'session should read tracks');

    // --- Role checks on admin-only routes ---
    const adminOnly = [
      ['GET', '/users'],
      ['POST', '/users', { username: 'x1', password: 'password one' }],
      ['PATCH', '/users/1', { role: 'user' }],
      ['DELETE', '/users/1'],
      ['POST', '/backup/restore', { confirm: 'RESTORE', backup: {} }],
      ['GET', '/backup/export'],
      ['POST', '/backup/preview', { backup: {} }],
      ['PUT', '/settings/prowlarr', { baseUrl: 'http://127.0.0.1:1', apiKey: 'fake' }],
      ['POST', '/settings/prowlarr/test'],
      ['PUT', '/settings/spotify', { clientId: 'a', clientSecret: 'b' }],
      ['POST', '/settings/spotify/test'],
      ['PUT', '/settings/notifications', { discordWebhookUrl: 'http://127.0.0.1:1/x' }],
      ['POST', '/settings/notifications/test'],
      ['PUT', '/settings/rtorrent', { host: 'h', user: 'u', sshKeyPath: '/k', socketPath: '/s' }],
      ['POST', '/settings/rtorrent/test'],
      ['PUT', '/settings/download-client', { type: 'rtorrent', host: 'h', user: 'u', sshKeyPath: '/k', socketPath: '/s' }],
      ['POST', '/settings/download-client/test'],
      ['PUT', '/settings/library', { musicVideosPath: '/tmp/x' }],
      ['POST', '/settings/library/test'],
    ];
    for (const [method, route, body] of adminOnly) {
      const res = await call(base, method, route, { headers: user, body });
      assert(res.status === 403, `${method} ${route} should be 403 for a non-admin, got ${res.status}`);
    }
    // Secrets must not have been written by the rejected calls above.
    const prowlarrCfg = await call(base, 'GET', '/settings/prowlarr', { headers: admin });
    assert(!prowlarrCfg.data.apiKey, 'rejected prowlarr PUT must not store anything');

    assert((await call(base, 'GET', '/backup/export', { headers: admin })).status === 200, 'admin can export a backup');
  } finally {
    child.kill();
  }
}

main()
  .then(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('API auth tests OK');
  })
  .catch((e) => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.error(e.message);
    process.exit(1);
  });
