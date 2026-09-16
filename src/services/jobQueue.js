// Real background job queue - the piece that was actually missing to make
// this feel like a member of the *arr family rather than a request/response
// script. Before this, POST /tracks/:id/download held the HTTP connection
// open for the full multi-minute duration of a real yt-dlp download + SCP
// upload, with no queue, no visibility into what else was running, and no
// limit on how many downloads could run at once if two requests landed
// close together. Every real *arr app has a queue/activity view backed by
// something like this - Ragearr never did.
//
// Deliberately simple: one job at a time (matches this app's existing
// single-process, single-yt-dlp-at-a-time reality - queueing rather than
// parallelizing is itself the fix, not a limitation to work around), an
// in-process interval loop rather than a separate worker process (SQLite +
// a single Node process is this project's whole stack, see CONTRIBUTING.md
// - a real job runner like BullMQ would need Redis, a dependency this app
// has no other reason to take on).

const db = require('../db');

const handlers = new Map();
let running = false;

function registerHandler(type, fn) {
  handlers.set(type, fn);
}

function enqueue(type, refId, label) {
  const info = db
    .prepare("INSERT INTO jobs (type, ref_id, label, status) VALUES (?, ?, ?, 'queued')")
    .run(type, refId, label);
  setImmediate(processNext);
  return info.lastInsertRowid;
}

function updateProgress(jobId, message) {
  db.prepare("UPDATE jobs SET message = ?, updated_at = datetime('now') WHERE id = ?").run(message, jobId);
}

async function processNext() {
  if (running) return; // one at a time, and only one loop iteration in flight
  const job = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1").get();
  if (!job) return;

  running = true;
  db.prepare("UPDATE jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(job.id);

  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`no handler registered for job type '${job.type}'`);
    await handler(job, (message) => updateProgress(job.id, message));
    db.prepare("UPDATE jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
  } catch (e) {
    db.prepare("UPDATE jobs SET status = 'failed', message = ?, updated_at = datetime('now') WHERE id = ?").run(e.message, job.id);
  } finally {
    running = false;
    setImmediate(processNext); // pick up whatever's next, if anything
  }
}

// Catches any job left 'running' from a previous process instance (e.g. the
// container was recreated mid-download) - it can never actually finish,
// so mark it failed rather than let it sit forever looking "in progress".
function recoverStuckJobs() {
  db.prepare("UPDATE jobs SET status = 'failed', message = 'interrupted by a restart', updated_at = datetime('now') WHERE status IN ('queued', 'running')").run();
}

module.exports = { registerHandler, enqueue, processNext, recoverStuckJobs };
