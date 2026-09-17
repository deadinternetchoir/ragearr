#!/usr/bin/env node

const baseUrl = (process.env.RAGEARR_BASE_URL || 'http://127.0.0.1:5299').replace(/\/$/, '');
const apiKey = process.env.RAGEARR_API_KEY || '';

function headers(body) {
  const out = body ? { 'Content-Type': 'application/json' } : {};
  if (apiKey) out['X-Api-Key'] = apiKey;
  return out;
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: options.method || 'GET',
    headers: headers(options.body),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${data?.error || 'no error body'}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const health = await request('/health');
  assert(health.status === 'ok', 'health endpoint did not return ok');

  const quality = await request('/quality-profiles');
  assert(Array.isArray(quality.profiles) && quality.profiles.length > 0, 'quality profiles missing');
  assert(quality.defaultProfileId, 'default quality profile missing');

  const tracks = await request('/tracks');
  assert(Array.isArray(tracks), 'tracks response is not an array');
  if (tracks.length > 0) {
    assert(Object.prototype.hasOwnProperty.call(tracks[0], 'monitored'), 'tracks missing monitored field');
    assert(Object.prototype.hasOwnProperty.call(tracks[0], 'quality_profile'), 'tracks missing quality_profile field');
    assert(Object.prototype.hasOwnProperty.call(tracks[0], 'thumbnail_url'), 'tracks missing thumbnail_url field');
  }

  const importPreview = await request('/import-lists/preview', {
    method: 'POST',
    body: {
      text: 'artist,track name,album,duration\nSmoke Artist,Smoke Track,Smoke Album,3:01\nSmoke Artist,Smoke Track,Smoke Album,181',
    },
  });
  assert(importPreview.source_type === 'import_list', 'import preview source type mismatch');
  assert(importPreview.counts.total === 2, 'import preview total mismatch');
  assert(importPreview.counts.importable === 1, 'import preview should mark one row importable');
  assert(importPreview.counts.duplicateInImport === 1, 'import preview should detect duplicate input row');

  const spotifyPreview = await request('/import-lists/preview', {
    method: 'POST',
    body: {
      text: 'Track Name,Artist Name(s),Album Name,Duration (ms),Track URI\nSmoke Spotify Track,Smoke Spotify Artist,Smoke Spotify Album,181000,spotify:track:smoke',
    },
  });
  assert(spotifyPreview.source_type === 'spotify_export', 'spotify export source type mismatch');
  assert(spotifyPreview.counts.total === 1, 'spotify export preview total mismatch');
  assert(spotifyPreview.rows[0].duration_sec === 181, 'spotify export duration did not parse from ms');

  const system = await request('/system/health');
  assert(Array.isArray(system.checks), 'system health checks missing');
  for (const id of ['api_auth', 'sqlite', 'jobs']) {
    assert(system.checks.some((check) => check.id === id), `system health missing ${id}`);
  }
  assert(system.checks.some((check) => check.id === 'download_client'), 'system health missing download client');

  const downloadClient = await request('/settings/download-client');
  assert(Array.isArray(downloadClient.supportedTypes), 'download client supported types missing');
  assert(downloadClient.supportedTypes.some((type) => type.id === downloadClient.type), 'active download client type should be supported');
  assert(downloadClient.supportedTypes.some((type) => type.id === 'qbittorrent'), 'qBittorrent download client type missing');

  const candidateRules = await request('/settings/candidate-rules');
  assert(Array.isArray(candidateRules.preferredPhrases), 'candidate rules preferred phrases missing');
  assert(candidateRules.highTierScore != null, 'candidate rules high tier score missing');

  const spotify = await request('/settings/spotify');
  assert(Object.prototype.hasOwnProperty.call(spotify, 'configured'), 'spotify settings missing configured flag');

  const authStatus = await request('/auth/status');
  assert(Object.prototype.hasOwnProperty.call(authStatus, 'usersConfigured'), 'auth status missing usersConfigured flag');

  const library = await request('/settings/library');
  assert(Array.isArray(library.musicVideoRootFolders), 'library settings missing music-video root folders');
  assert(Array.isArray(library.concertRootFolders), 'library settings missing concert root folders');

  const backup = await request('/backup/export');
  assert(backup.app === 'ragearr', 'backup export app marker missing');
  assert(backup.counts && typeof backup.counts.tracks === 'number', 'backup export counts missing');
  const backupPreview = await request('/backup/preview', { method: 'POST', body: { backup } });
  assert(backupPreview.summary?.counts?.tracks === backup.counts.tracks, 'backup preview track count mismatch');

  console.log(`Smoke OK: ${baseUrl} (${tracks.length} tracks, system=${system.status})`);
}

main().catch((err) => {
  console.error(`Smoke failed: ${err.message}`);
  process.exit(1);
});
