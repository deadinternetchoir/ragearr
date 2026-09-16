#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-users-'));

const db = require('../src/db');
const users = require('../src/services/users');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const admin = users.createUser({ username: 'Admin.User', password: 'correct horse battery staple', role: 'admin' });
assert(admin.username === 'admin.user', 'username should normalize');
assert(admin.role === 'admin', 'admin role should persist');
assert(users.countUsers() === 1, 'user count should increment');

const failed = users.authenticate('admin.user', 'wrong password');
assert(failed === null, 'wrong password should not authenticate');

const authed = users.authenticate('ADMIN.USER', 'correct horse battery staple');
assert(authed && authed.id === admin.id, 'correct password should authenticate case-insensitively');

const session = users.createSession(admin.id);
const sessionUser = users.userForToken(session.token);
assert(sessionUser.username === 'admin.user', 'session token should resolve user');

const normal = users.createUser({ username: 'viewer', password: 'viewer password', role: 'user' });
users.updateUser(normal.id, { role: 'admin', password: 'new viewer password' });
assert(users.authenticate('viewer', 'viewer password') === null, 'old password should stop working after reset');
assert(users.authenticate('viewer', 'new viewer password').role === 'admin', 'new password and role should work');

users.deleteSession(session.token);
assert(users.userForToken(session.token) === null, 'deleted session should not resolve');

users.deleteUser(normal.id);
assert(users.listUsers().length === 1, 'deleteUser should remove user');

let duplicateFailed = false;
try {
  users.createUser({ username: 'admin.user', password: 'another password', role: 'user' });
} catch (e) {
  duplicateFailed = /already exists/.test(e.message);
}
assert(duplicateFailed, 'duplicate username should fail');

db.close();
fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
console.log('User tests OK');
