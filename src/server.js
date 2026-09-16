const express = require('express');
const path = require('path');
const db = require('./db');
const apiRouter = require('./routes/api');
const jobQueue = require('./services/jobQueue');
const thumbnails = require('./services/thumbnails');
const users = require('./services/users');

const app = express();
const PORT = process.env.PORT || 5299;
const API_KEY = process.env.RAGEARR_API_KEY || '';

// Any job still 'queued'/'running' at process start belongs to a container
// that was killed mid-job (a redeploy, a crash) - it can never actually
// finish, so mark it failed rather than let it sit forever looking active.
jobQueue.recoverStuckJobs();
users.deleteExpiredSessions();

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated-thumbnails', express.static(thumbnails.THUMBNAIL_DIR));

function suppliedApiKey(req) {
  const auth = req.get('authorization') || '';
  return req.get('x-api-key') || req.query.apikey || '';
}

function suppliedBearer(req) {
  const auth = req.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

function authFromRequest(req) {
  const apiKey = suppliedApiKey(req);
  if (API_KEY && apiKey === API_KEY) {
    return { type: 'api_key', role: 'admin', user: { id: null, username: 'api-key', role: 'admin' } };
  }

  const bearer = suppliedBearer(req);
  if (API_KEY && bearer === API_KEY) {
    return { type: 'api_key', role: 'admin', user: { id: null, username: 'api-key', role: 'admin' } };
  }

  const sessionToken = req.get('x-session-token') || bearer;
  const user = users.userForToken(sessionToken);
  if (user) return { type: 'session', role: user.role, user, token: sessionToken };
  return null;
}

function apiKeyAuth(req, res, next) {
  const auth = authFromRequest(req);
  if (auth) {
    req.auth = auth;
    return next();
  }

  if (!API_KEY && users.countUsers() === 0) {
    req.auth = { type: 'open', role: 'admin', user: { id: null, username: 'open', role: 'admin' } };
    return next();
  }

  return res.status(401).json({ error: 'Login or API key required' });
}

app.get('/api/auth/status', (req, res) => {
  const auth = authFromRequest(req);
  res.json({
    apiKeyConfigured: Boolean(API_KEY),
    usersConfigured: users.countUsers() > 0,
    user: auth?.user || null,
    authType: auth?.type || null,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = users.authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const session = users.createSession(user.id);
  res.json({ ok: true, user, ...session });
});

app.use('/api', apiKeyAuth);
app.use('/api', apiRouter);

app.get('/api/health', (req, res) => {
  const trackCount = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  res.json({ status: 'ok', tracks: trackCount });
});

app.listen(PORT, () => {
  console.log(`Ragearr listening on port ${PORT}`);
  if (!API_KEY) console.warn('RAGEARR_API_KEY is not set; API auth is disabled.');
});
