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

    // --- Last-admin protection and session revocation ---
    const bossLogin = await call(base, 'POST', '/auth/login', { body: { username: 'boss', password: 'boss password' } });
    const boss = { 'X-Session-Token': bossLogin.data.token };
    const list = await call(base, 'GET', '/users', { headers: boss });
    const bossId = list.data.users.find((u) => u.username === 'boss').id;
    const viewerId = list.data.users.find((u) => u.username === 'viewer').id;

    const demote = await call(base, 'PATCH', `/users/${bossId}`, { headers: boss, body: { role: 'user' } });
    assert(demote.status === 400, `demoting the last admin should be 400, got ${demote.status}`);
    assert((await call(base, 'GET', '/users', { headers: boss })).status === 200, 'admin must still be an admin after the refused demotion');

    // With a second admin, demotion is allowed again.
    assert((await call(base, 'PATCH', `/users/${viewerId}`, { headers: boss, body: { role: 'admin' } })).status === 200, 'promote viewer');
    assert((await call(base, 'PATCH', `/users/${bossId}`, { headers: boss, body: { role: 'user' } })).status === 200, 'demote with another admin present');
    assert((await call(base, 'GET', '/users', { headers: boss })).status === 403, 'demoted session loses admin access immediately');
    assert((await call(base, 'PATCH', `/users/${viewerId}`, { headers: user, body: { role: 'user' } })).status === 400, 'last admin cannot demote themselves either');

    // Changing a password signs the user's other sessions out; the caller's own session survives.
    const second = await call(base, 'POST', '/auth/login', { body: { username: 'viewer', password: 'viewer password' } });
    const otherSession = { 'X-Session-Token': second.data.token };
    assert((await call(base, 'GET', '/tracks', { headers: otherSession })).status === 200, 'second session works');
    const pw = await call(base, 'PATCH', `/users/${viewerId}`, { headers: user, body: { password: 'brand new password' } });
    assert(pw.status === 200, 'password change');
    assert((await call(base, 'GET', '/tracks', { headers: otherSession })).status === 401, 'other sessions must be revoked after a password change');
    assert((await call(base, 'GET', '/tracks', { headers: user })).status === 200, 'the session that changed the password stays signed in');
    // An admin resetting someone else's password revokes all of that user's sessions.
    const bossRelogin = await call(base, 'POST', '/auth/login', { body: { username: 'boss', password: 'boss password' } });
    const bossSession = { 'X-Session-Token': bossRelogin.data.token };
    assert((await call(base, 'PATCH', `/users/${viewerId}`, { headers: admin, body: { role: 'admin' } })).status === 200, 'restore admin');
    assert((await call(base, 'PATCH', `/users/${bossId}`, { headers: admin, body: { password: 'reset by admin' } })).status === 200, 'admin resets boss password');
    assert((await call(base, 'GET', '/tracks', { headers: bossSession })).status === 401, "reset user's sessions must be revoked");
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
