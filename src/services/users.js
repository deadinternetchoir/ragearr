const crypto = require('crypto');
const db = require('../db');

const HASH_ITERATIONS = 120000;
const SESSION_DAYS = 30;

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, HASH_ITERATIONS, 32, 'sha256').toString('hex');
  return `pbkdf2-sha256$${HASH_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'hex');
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, expected.length, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser);
}

function getUser(id) {
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function validateRole(role) {
  if (role !== 'admin' && role !== 'user') throw new Error('role must be admin or user');
  return role;
}

function validatePassword(password) {
  if (!password || String(password).length < 8) throw new Error('password must be at least 8 characters');
}

function createUser({ username, password, role = 'user' }) {
  const cleanUsername = normalizeUsername(username);
  if (!cleanUsername) throw new Error('username is required');
  if (!/^[a-z0-9._-]{2,64}$/.test(cleanUsername)) throw new Error('username must be 2-64 characters and use letters, numbers, dot, dash, or underscore');
  validatePassword(password);
  const cleanRole = validateRole(role);
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(cleanUsername, hashPassword(password), cleanRole);
    return getUser(info.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('username already exists');
    throw e;
  }
}

function updateUser(id, { password, role }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('user not found');
  const updates = [];
  const params = [];
  if (password !== undefined && password !== '') {
    validatePassword(password);
    updates.push('password_hash = ?');
    params.push(hashPassword(password));
  }
  if (role !== undefined) {
    updates.push('role = ?');
    params.push(validateRole(role));
  }
  if (updates.length === 0) return publicUser(user);
  updates.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getUser(id);
}

function deleteUser(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('user not found');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function authenticate(username, password) {
  const cleanUsername = normalizeUsername(username);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  return publicUser({ ...user, last_login_at: new Date().toISOString() });
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

function userForToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT users.*, sessions.expires_at
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?
         AND datetime(sessions.expires_at) > datetime('now')`
    )
    .get(token);
  return row ? publicUser(row) : null;
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')").run();
}

module.exports = {
  SESSION_DAYS,
  countUsers,
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  authenticate,
  createSession,
  userForToken,
  deleteSession,
  deleteExpiredSessions,
  publicUser,
};
