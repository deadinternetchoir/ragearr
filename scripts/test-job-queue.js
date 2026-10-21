#!/usr/bin/env node
// Job queue behaviour: duplicate suppression, failure handling, restart recovery.
// Uses a temp database; no downloads are attempted.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAGEARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ragearr-jobs-'));
process.env.RAGEARR_KNOWN_HOSTS = path.join(process.env.RAGEARR_DATA_DIR, 'known_hosts');

const db = require('../src/db');
const jobQueue = require('../src/services/jobQueue');
require('../src/routes/api'); // registers the real 'track_download' handler

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(fn, what, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const jobStatus = (id) => db.prepare('SELECT status, message FROM jobs WHERE id = ?').get(id);
const trackStatus = (id) => db.prepare('SELECT status FROM tracks WHERE id = ?').get(id)?.status;

function addTrack(status) {
  return db.prepare('INSERT INTO tracks (artist, track_name, status) VALUES (?, ?, ?)').run('Artist', `Song ${Math.random()}`, status).lastInsertRowid;
}

async function main() {
  // The same work is not queued twice while it is queued or running.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const runs = {};
  jobQueue.registerHandler('test_gate', async (job) => {
    runs[job.ref_id] = (runs[job.ref_id] || 0) + 1;
    await gate;
  });
  const first = jobQueue.enqueue('test_gate', 7, 'gated');
  const second = jobQueue.enqueue('test_gate', 7, 'gated');
  assert(first === second, 'a second enqueue for the same type/ref should return the existing job id');
  await waitFor(() => jobStatus(first).status === 'running', 'gated job to start');
  assert(jobQueue.enqueue('test_gate', 7, 'gated') === first, 'enqueue while running should return the running job');
  assert(jobQueue.enqueue('test_gate', 8, 'other') !== first, 'a different ref is a different job');
  release();
  await waitFor(() => jobStatus(first).status === 'done', 'gated job to finish');
  await waitFor(() => !db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running')").get(), 'queue to drain');
  assert(runs[7] === 1, `handler should have run once for the duplicated ref, ran ${runs[7]}`);
  await waitFor(() => !db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running')").get(), 'queue to drain');
  assert(jobQueue.enqueue('test_gate', 7, 'gated again') !== first, 'once finished, the same ref can be queued again');
  await waitFor(() => !db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running')").get(), 'queue to drain again');

  // A download job that cannot start must not leave its track stuck in 'downloading'.
  const noCandidate = addTrack('downloading');
  const failing = jobQueue.enqueue('track_download', noCandidate, 'no candidate');
  await waitFor(() => jobStatus(failing).status === 'failed', 'job without a candidate to fail');
  assert(/no candidate/.test(jobStatus(failing).message), 'failure message should say why');
  assert(trackStatus(noCandidate) === 'approved', `track should return to approved, is ${trackStatus(noCandidate)}`);

  const missing = jobQueue.enqueue('track_download', 999999, 'vanished track');
  await waitFor(() => jobStatus(missing).status === 'failed', 'job for a deleted track to fail');

  // Unknown job types fail cleanly rather than hanging the queue.
  const unknown = jobQueue.enqueue('no_such_type', 1, 'unknown');
  await waitFor(() => jobStatus(unknown).status === 'failed', 'unknown job type to fail');

  // After a restart, jobs that can never finish are failed and their tracks released.
  const interrupted = addTrack('downloading');
  db.prepare("INSERT INTO jobs (type, ref_id, label, status) VALUES ('track_download', ?, 'x', 'running')").run(interrupted);
  db.prepare("INSERT INTO jobs (type, ref_id, label, status) VALUES ('track_download', ?, 'y', 'queued')").run(interrupted);
  const unrelated = addTrack('imported');
  jobQueue.recoverStuckJobs();
  assert(!db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running')").get(), 'recovery should fail all unfinished jobs');
  assert(trackStatus(interrupted) === 'approved', 'a track whose download was interrupted should be released');
  assert(trackStatus(unrelated) === 'imported', 'other tracks are untouched');
}

main()
  .then(() => {
    db.close();
    fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
    console.log('Job queue tests OK');
  })
  .catch((e) => {
    console.error(e.message);
    fs.rmSync(process.env.RAGEARR_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  });
