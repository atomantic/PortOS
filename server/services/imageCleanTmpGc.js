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

// Grace window before a temp clean file is eligible for deletion, measured
// against mtime. An hour is generous next to the seconds-to-minutes a GPU clean
// takes, while sparing an in-flight render or an un-fetched result.
export const CLEAN_TMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

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
} = {}) {
  const entries = await readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (files.length === 0) return { deleted: 0, keptYoung: 0 };

  let deleted = 0;
  let keptYoung = 0;
  for (const name of files) {
    const info = await stat(join(tmpDir, name)).catch(() => null);
    if (!info) continue; // vanished under us — nothing to do
    if (now - info.mtimeMs < maxAgeMs) {
      keptYoung += 1;
      continue;
    }
    const removed = await unlink(join(tmpDir, name)).then(() => true).catch(() => false);
    if (removed) deleted += 1;
  }
  return { deleted, keptYoung };
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
