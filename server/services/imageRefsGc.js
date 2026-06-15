/**
 * Staged-upload image-refs GC (issue #1214)
 *
 * Init/reference uploads for i2i / edit renders are staged into
 * `data/image-refs` with a fresh UUID name (`init-<uuid>.png` / `ref-<uuid>.png`)
 * on EVERY render (`imageGen/prepareParams.js`). They are never cleaned up, so
 * `data/image-refs` grows without bound for any user who does repeated
 * edit-from-upload renders. (Migration 085 relocated these out of the gallery
 * dir, fixing the visible duplicate-card bug, but the unbounded accumulation
 * was left silent rather than solved.)
 *
 * This periodic sweep deletes `init-`/`ref-`-prefixed files in `data/image-refs`
 * that are BOTH:
 *   (a) not referenced by any gallery sidecar's `initImageFilename` /
 *       `referenceImageFilenames` basenames, AND
 *   (b) older than a grace window.
 *
 * Why BOTH gates (not either):
 * - The reference check alone is unsafe — the codex backend does NOT record an
 *   `initImageFilename` in its sidecar, so a still-wanted init upload behind a
 *   codex render would look unreferenced. The age gate is the backstop: a file
 *   younger than the window is spared regardless, covering codex lineage and
 *   renders still in flight (the staged file exists before its sidecar is
 *   written).
 * - The age check alone is unsafe — a long-lived gallery image that still
 *   points at an old init upload would lose its lineage source. The reference
 *   check protects those: any basename a kept sidecar names is never swept,
 *   no matter how old.
 *
 * Conservative by construction: only the `init-<uuid>` / `ref-<uuid>` staged
 * pattern is a candidate (the same discriminator migration 085 uses). Character
 * reference sheets (`universe-…`, `sheet-…`) and any other file in the dir are
 * never matched.
 *
 * Runs OUTSIDE the Express request lifecycle (a `setInterval` from index.js),
 * so this module wraps its sweep in try/catch and logs single-line per the repo
 * logging convention — an uncaught throw here would crash the process.
 */

import { readdir, stat, unlink } from 'fs/promises';
import { join, basename } from 'path';
import { PATHS, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';

// `init-<uuid>` / `ref-<uuid>` with a decodable image extension — the exact
// staged-upload discriminator migration 085 uses. The UUID shape is loose on
// purpose (any hex/dash run) so files staged by older builds are still caught.
const STAGED_UPLOAD_RE = /^(?:init|ref)-[0-9a-f-]+\.(?:png|jpe?g|webp)$/i;

// Grace window before an unreferenced staged upload is eligible for deletion.
// Measured against the file's mtime. Generous on purpose: the cost of a stale
// upload lingering an extra week is trivial next to deleting an init/reference
// source a render (e.g. a sidecar-less codex edit) still depends on.
export const ORPHAN_REF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// How often the sweep runs once started. These files are cheap to leave around,
// so a slow cadence is fine — daily keeps `data/image-refs` bounded without churn.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let sweepTimer = null;
let initialSweepTimer = null;

/**
 * Scan every gallery sidecar and collect the set of `data/image-refs` basenames
 * any kept image still references (`initImageFilename` + `referenceImageFilenames`).
 * A basename in this set is never swept regardless of age.
 *
 * Reads the `*.metadata.json` sidecars directly rather than going through
 * `listGallery()` so the dir is injectable for tests and we don't pay for the
 * full gallery sort/shape we don't need here.
 */
export async function collectReferencedRefBasenames(imagesDir = PATHS.images) {
  const referenced = new Set();
  // A missing/unreadable images dir yields [] (no sidecars → nothing referenced).
  const entries = await readdir(imagesDir).catch(() => []);
  for (const name of entries) {
    if (!name.endsWith('.metadata.json')) continue;
    const raw = await tryReadFile(join(imagesDir, name));
    if (raw == null) continue;
    const meta = safeJSONParse(raw, {});
    if (typeof meta.initImageFilename === 'string' && meta.initImageFilename) {
      referenced.add(basename(meta.initImageFilename));
    }
    if (Array.isArray(meta.referenceImageFilenames)) {
      for (const f of meta.referenceImageFilenames) {
        if (typeof f === 'string' && f) referenced.add(basename(f));
      }
    }
  }
  return referenced;
}

/**
 * One GC pass. Pure-ish: takes `now` so tests can pin the clock, plus optional
 * dir overrides. A staged-upload file is deleted only when it is NOT referenced
 * by any gallery sidecar AND its mtime is older than `maxAgeMs`.
 *
 * Returns `{ deleted, keptReferenced, keptYoung }` counts.
 */
export async function sweepOrphanRefImages({
  now = Date.now(),
  maxAgeMs = ORPHAN_REF_MAX_AGE_MS,
  refsDir = PATHS.imageRefs,
  imagesDir = PATHS.images,
} = {}) {
  // A missing/unreadable refs dir yields [] → no candidates → all-zero result.
  const entries = await readdir(refsDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((e) => e.isFile() && STAGED_UPLOAD_RE.test(e.name))
    .map((e) => e.name);
  if (candidates.length === 0) return { deleted: 0, keptReferenced: 0, keptYoung: 0 };

  const referenced = await collectReferencedRefBasenames(imagesDir);

  let deleted = 0;
  let keptReferenced = 0;
  let keptYoung = 0;
  for (const name of candidates) {
    // A basename a kept gallery sidecar still names is lineage we must keep,
    // regardless of age.
    if (referenced.has(name)) {
      keptReferenced += 1;
      continue;
    }
    // mtime backstop — spare anything younger than the grace window so a
    // sidecar-less codex render or an in-flight render isn't swept early. A
    // stat failure means the file vanished under us; skip it silently.
    const info = await stat(join(refsDir, name)).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs < maxAgeMs) {
      keptYoung += 1;
      continue;
    }
    // Count only a genuine removal so the summary log can't over-report. A
    // concurrent vanish (ENOENT) or any unlink failure leaves `deleted` untouched.
    const removed = await unlink(join(refsDir, name)).then(() => true).catch(() => false);
    if (removed) deleted += 1;
  }

  return { deleted, keptReferenced, keptYoung };
}

/**
 * Start the periodic sweep. Fires once on a short delay after boot (so a long
 * grace window doesn't mean accumulation waits a full day after a restart) then
 * on SWEEP_INTERVAL_MS. Idempotent — a second call is a no-op.
 */
export function startImageRefsGc() {
  if (sweepTimer) return;

  const runSweep = () => {
    sweepOrphanRefImages()
      .then(({ deleted }) => {
        if (deleted > 0) {
          console.log(`🧹 Image-refs GC: removed ${deleted} orphan staged upload(s)`);
        }
      })
      .catch((err) => console.error(`❌ Image-refs GC sweep failed: ${err.message}`));
  };

  // Initial pass ~5 min after boot — off the startup hot path, but soon enough
  // that a restart doesn't reset the cleanup clock. Keep the handle so
  // stopImageRefsGc() can cancel it if shutdown lands inside the window.
  initialSweepTimer = setTimeout(() => { initialSweepTimer = null; runSweep(); }, 5 * 60 * 1000);
  initialSweepTimer.unref?.();
  sweepTimer = setInterval(runSweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Stop the periodic sweep (used by tests / graceful shutdown). */
export function stopImageRefsGc() {
  if (initialSweepTimer) {
    clearTimeout(initialSweepTimer);
    initialSweepTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
