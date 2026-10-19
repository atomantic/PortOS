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
 *   (a) not referenced by any gallery sidecar's applied, requested or omitted
 *       input filenames, AND
 *   (b) older than a grace window.
 *
 * Why BOTH gates (not either):
 * - The reference check alone is unsafe — newly staged inputs exist before a
 *   render publishes its sidecar. The age gate spares those in-flight uploads
 *   and gives legacy uploads without recorded lineage a grace window.
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
 * Runs OUTSIDE the Express request lifecycle through eventScheduler, which
 * catches handler failures and records them in scheduler history.
 */

import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { PATHS, unlinkGuarded } from '../lib/fileUtils.js';
import { readJSONFileStrict, unreadableStoreError } from '../lib/jsonIo.js';
import { isPlainObject } from '../lib/objects.js';
import { createSweepScheduler } from './sweepScheduler.js';

// `init-<uuid>` / `ref-<uuid>` with a decodable image extension — the exact
// staged-upload discriminator migration 085 uses. The UUID shape is loose on
// purpose (any hex/dash run) so files staged by older builds are still caught.
const STAGED_UPLOAD_RE = /^(?:init|ref)-[0-9a-f-]+\.(?:png|jpe?g|webp)$/i;

// Grace window before an unreferenced staged upload is eligible for deletion.
// Measured against the file's mtime. Generous on purpose: the cost of a stale
// upload lingering an extra week is trivial next to deleting an init/reference
// source before its render publishes the sidecar.
export const ORPHAN_REF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// How often the sweep runs once started. These files are cheap to leave around,
// so a slow cadence is fine — daily keeps `data/image-refs` bounded without churn.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Scan every gallery sidecar and collect the set of `data/image-refs` basenames
 * any kept image still references, including requested or omitted provider inputs.
 * A basename in this set is never swept regardless of age. An incomplete scan
 * rejects before the sweep deletes anything; only a missing gallery is empty.
 *
 * Reads the `*.metadata.json` sidecars directly rather than going through
 * `listGallery()` so the dir is injectable for tests and we don't pay for the
 * full gallery sort/shape we don't need here.
 */
export async function collectReferencedRefBasenames(imagesDir = PATHS.images) {
  const referenced = new Set();
  const entries = await readdir(imagesDir).catch(err => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  for (const name of entries) {
    if (!name.endsWith('.metadata.json')) continue;
    const path = join(imagesDir, name);
    const { ok, value: meta } = await readJSONFileStrict(path, null, { logError: false });
    // Even ENOENT here is an incomplete scan: a listed sidecar disappearing
    // can be an in-flight replacement, not proof that its inputs are orphaned.
    if (!ok || !isPlainObject(meta)) throw unreadableStoreError(path);
    const filenames = [];
    if (meta.initImageFilename != null) filenames.push(meta.initImageFilename);
    if (meta.referenceImageFilenames != null) {
      if (!Array.isArray(meta.referenceImageFilenames)) throw unreadableStoreError(path);
      filenames.push(...meta.referenceImageFilenames);
    }
    for (const field of ['requestedInputImages', 'omittedInputImages']) {
      if (meta[field] == null) continue;
      if (!Array.isArray(meta[field])) throw unreadableStoreError(path);
      for (const input of meta[field]) {
        if (!isPlainObject(input)) throw unreadableStoreError(path);
        filenames.push(input.filename);
      }
    }
    for (const filename of filenames) {
      if (typeof filename !== 'string') throw unreadableStoreError(path);
      if (filename) referenced.add(basename(filename));
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
    // legacy sidecar-less render or an in-flight render isn't swept early. A
    // stat failure means the file vanished under us; skip it silently.
    const info = await stat(join(refsDir, name)).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs < maxAgeMs) {
      keptYoung += 1;
      continue;
    }
    // Count only a genuine removal so the summary log can't over-report. A
    // concurrent vanish (ENOENT) or any unlink failure leaves `deleted` untouched.
    const removed = await unlinkGuarded(join(refsDir, name)).then(() => true).catch(() => false);
    if (removed) deleted += 1;
  }

  return { deleted, keptReferenced, keptYoung };
}

/**
 * Log the domain summary for one scheduler-owned sweep.
 */
const runSweep = async () => {
  const { deleted } = await sweepOrphanRefImages();
  if (deleted > 0) {
    console.log(`🧹 Image-refs GC: removed ${deleted} orphan staged upload(s)`);
  }
};

export const {
  start: startImageRefsGc,
  stop: stopImageRefsGc,
} = createSweepScheduler({
  id: 'image-refs-gc',
  intervalMs: SWEEP_INTERVAL_MS,
  initialDelayMs: 5 * 60 * 1000,
  handler: runSweep,
  source: 'imageRefsGc',
});
