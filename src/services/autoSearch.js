// Hourly housekeeping that keeps wanted tracks moving without anyone clicking:
//  - searches monitored tracks that have never been searched (new imports),
//  - retries "no match" tracks after a few days (a video may have appeared),
//  - checks imported files for a higher-resolution version when the track's quality
//    profile allows more than the file has (quality upgrades).
// It only queues background jobs (see jobQueue.js, one at a time). Search results wait
// as candidates for review; nothing is approved or downloaded for a new track on its own.
const db = require('../db');
const settings = require('./settings');
const jobQueue = require('./jobQueue');
const qualityProfiles = require('./qualityProfiles');

const HOUR_MS = 60 * 60 * 1000;
const UPGRADE_RECHECK_DAYS = 7;
let timer = null;

function getConfig() {
  const cfg = settings.get('autoSearch') || {};
  const quality = settings.get('quality') || {};
  return {
    enabled: cfg.enabled !== false,
    retryNoMatchDays: Number.isFinite(Number(cfg.retryNoMatchDays)) ? Math.max(1, Number(cfg.retryNoMatchDays)) : 7,
    upgradesEnabled: quality.upgradesEnabled !== false,
  };
}

function setConfig(body) {
  const current = getConfig();
  const next = {
    enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
    retryNoMatchDays: body.retryNoMatchDays === undefined ? current.retryNoMatchDays : Math.min(365, Math.max(1, parseInt(body.retryNoMatchDays, 10) || 7)),
  };
  settings.set('autoSearch', next);
  if (body.upgradesEnabled !== undefined) {
    settings.set('quality', { ...(settings.get('quality') || {}), upgradesEnabled: Boolean(body.upgradesEnabled) });
  }
  return getConfig();
}

// Queues work and returns what it queued. Safe to call repeatedly: the queue refuses a
// duplicate of a job that is already waiting or running.
function run() {
  const cfg = getConfig();
  const out = { searches: 0, retries: 0, upgrades: 0 };

  const fresh = db.prepare("SELECT id, artist, track_name FROM tracks WHERE monitored = 1 AND status = 'pending' ORDER BY id").all();
  for (const t of fresh) {
    jobQueue.enqueue('track_search', t.id, `Search: ${t.artist} - ${t.track_name}`);
    out.searches++;
  }

  const retry = db
    .prepare(
      `SELECT id, artist, track_name FROM tracks
       WHERE monitored = 1 AND status = 'no_match'
         AND COALESCE(last_searched_at, updated_at) < datetime('now', ?) ORDER BY id`
    )
    .all(`-${cfg.retryNoMatchDays} days`);
  for (const t of retry) {
    jobQueue.enqueue('track_search', t.id, `Retry search: ${t.artist} - ${t.track_name}`);
    out.retries++;
  }

  if (cfg.upgradesEnabled) {
    const imported = db
      .prepare(
        `SELECT id, artist, track_name, quality_profile, file_height FROM tracks
         WHERE monitored = 1 AND status = 'imported' AND matched_file_path IS NOT NULL
           AND (upgrade_checked_at IS NULL OR upgrade_checked_at < datetime('now', ?)) ORDER BY id`
      )
      .all(`-${UPGRADE_RECHECK_DAYS} days`);
    for (const t of imported) {
      const profile = qualityProfiles.get(t.quality_profile);
      if (t.file_height && t.file_height >= profile.cutoffHeight) continue; // already at the cutoff
      jobQueue.enqueue('track_upgrade', t.id, `Upgrade check: ${t.artist} - ${t.track_name}`);
      out.upgrades++;
    }
  }
  return out;
}

function start() {
  if (timer) return;
  const tick = () => {
    try {
      if (getConfig().enabled) run();
    } catch (e) {
      console.error('auto-search error:', e.message);
    }
  };
  setTimeout(tick, 2 * 60 * 1000); // first pass shortly after start-up
  timer = setInterval(tick, HOUR_MS);
  timer.unref?.();
}

module.exports = { getConfig, setConfig, run, start };
