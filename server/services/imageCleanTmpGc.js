/**
 * Image Cleaner temp GC (issue #2264).
 *
 * The GPU FLUX clean round-trip stages ephemeral working files under
 * `PATHS.imageCleanTmp` — the sync-cleaned init (`init-<uuid>.png`), the render
 * (`<jobId>.png`), the preserve-region inputs (`<jobId>-original.png` /
 * `<jobId>-mask.png`), and a small `<jobId>-clean.json`. Unlike the gallery,
 * nothing here is ever referenced long-term: the client fetches the result once
 * (and optionally saves it to the gallery, which re-encodes a fresh copy). So a
 * plain mtime age-gate is enough — no reference tracking like imageRefsGc.
 *
 * The whole dir is fair game; the grace window just spares files from an
 * in-flight render or a result the user hasn't fetched yet. Kept short (an hour)
 * because a GPU clean completes and is fetched in seconds-to-minutes.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { listJobs } from './mediaJobQueue/index.js';

// Grace window before a temp clean file is eligible for deletion, measured
// against mtime. An hour is generous next to the seconds-to-minutes a GPU clean
// takes, while sparing an un-fetched result. The age-gate is a BACKSTOP — the
// primary safety is the active-job guard below (a queued job stuck behind a
// long render / first-run model download can sit well past an hour, and its
// init/mask/original must survive until it runs).
export const CLEAN_TMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Collect the temp-file basenames any queued/running media job still depends on
// so the sweep never deletes a not-yet-run job's init image, or the mask/
// original a completed-but-not-yet-fetched masked render needs to composite.
// A job's `initImagePath` names `image-clean-tmp/init-<uuid>.png`, and its id
// keys the `<jobId>-{mask,original,clean.json}` + `<jobId>.png` side files.
// Pure over its arg (the job list) so it's testable without the real queue.
export function collectActiveCleanBasenames(jobs = []) {
  const keep = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job?.kind !== 'image') continue;
    // Only in-flight jobs pin files; a terminal job's render is either already
    // fetched or up for age-gated collection.
    if (job.status !== 'queued' && job.status !== 'running') continue;
    const init = job.params?.initImagePath;
    if (typeof init === 'string' && init) {
      const base = init.split(/[/\\]/).pop();
      if (base) keep.add(base);
    }
    const id = typeof job.id === 'string' ? job.id : null;
    if (id) {
      keep.add(`${id}.png`);
      keep.add(`${id}-mask.png`);
      keep.add(`${id}-original.png`);
      keep.add(`${id}-clean.json`);
    }
  }
  return keep;
}

// How often the sweep runs once started. Cheap files, low churn — hourly keeps
// the dir bounded without busywork.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let sweepTimer = null;
let initialSweepTimer = null;

/**
 * Delete every file under `tmpDir` older than `maxAgeMs`. Returns
 * `{ deleted, keptYoung }`. A missing dir yields all-zero. Pure over its args so
 * tests can point it at a temp dir and pin `now`.
 */
export async function sweepImageCleanTmp({
  now = Date.now(),
  maxAgeMs = CLEAN_TMP_MAX_AGE_MS,
  tmpDir = PATHS.imageCleanTmp,
  activeJobs = null,
} = {}) {
  const entries = await readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (files.length === 0) return { deleted: 0, keptYoung: 0, keptActive: 0 };

  // Files pinned by a still-queued/running job are never swept, regardless of
  // age — a job stuck behind a long render can outlive the grace window.
  const jobs = activeJobs || listJobs({ kind: 'image' });
  const active = collectActiveCleanBasenames(jobs);

  let deleted = 0;
  let keptYoung = 0;
  let keptActive = 0;
  for (const name of files) {
    if (active.has(name)) { keptActive += 1; continue; }
    const info = await stat(join(tmpDir, name)).catch(() => null);
    if (!info) continue; // vanished under us — nothing to do
    if (now - info.mtimeMs < maxAgeMs) {
      keptYoung += 1;
      continue;
    }
    const removed = await unlink(join(tmpDir, name)).then(() => true).catch(() => false);
    if (removed) deleted += 1;
  }
  return { deleted, keptYoung, keptActive };
}

/**
 * Start the periodic sweep. Fires once ~5 min after boot (off the startup hot
 * path) then hourly. Idempotent — a second call is a no-op.
 */
export function startImageCleanTmpGc() {
  if (sweepTimer) return;

  const runSweep = () => {
    sweepImageCleanTmp()
      .then(({ deleted }) => {
        if (deleted > 0) console.log(`🧹 Image-clean temp GC: removed ${deleted} stale file(s)`);
      })
      .catch((err) => console.error(`❌ Image-clean temp GC sweep failed: ${err.message}`));
  };

  initialSweepTimer = setTimeout(() => { initialSweepTimer = null; runSweep(); }, 5 * 60 * 1000);
  initialSweepTimer.unref?.();
  sweepTimer = setInterval(runSweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Stop the periodic sweep (used by tests / graceful shutdown). */
export function stopImageCleanTmpGc() {
  if (initialSweepTimer) {
    clearTimeout(initialSweepTimer);
    initialSweepTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
