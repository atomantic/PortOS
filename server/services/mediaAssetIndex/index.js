/**
 * Media asset index — public entry / boot wiring (#1000).
 *
 * The index is a DERIVED Postgres mirror of on-disk media (see db.js). This
 * module owns its lifecycle:
 *   - initMediaAssetIndex() — called once at boot (after the DB gate). Subscribes
 *     to the existing image/video `completed` events so a freshly generated
 *     asset is indexed immediately, then runs a full reconcile so the index
 *     matches disk regardless of any events missed while the server was down.
 *   - unindexImage() / unindexVideo() — the delete-side mirror of those hooks,
 *     called by the media delete paths so a row dies with its file (#2738).
 *   - The reconcile + row I/O live in db.js; the pure transforms in logic.js.
 *
 * No hot-path generator edits: we hang off the `imageGenEvents` /
 * `videoGenEvents` 'completed' emitters that already fire on every render. The
 * handlers read the just-written sidecar / history entry and upsert one row.
 *
 * Escape hatch: under MEMORY_BACKEND=file or NODE_ENV=test there's no Postgres,
 * so the index is simply not maintained — the gallery/history still serve from
 * disk. init() no-ops in that case (mirrors how catalog features disable).
 */

import { checkHealth, ensureSchema } from '../../lib/db.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { videoGenEvents } from '../videoGen/events.js';
import { upsertAsset, removeAsset, reconcileMediaAssets } from './db.js';
import { imageMediaKey, imageToRow, videoMediaKey, videoToRow } from './logic.js';

export { reconcileMediaAssets } from './db.js';

let subscribed = false;

function isEscapeHatch() {
  return process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test';
}

// Index a single just-generated image. The 'completed' event carries the
// filename; the full metadata is in the sidecar the generator just wrote.
async function onImageCompleted({ filename, temp } = {}) {
  if (typeof filename !== 'string' || !filename) return;
  // A non-gallery temp render (issue #2264, Image Cleaner GPU pass) has no
  // gallery file or sidecar — skip indexing it. It lives in imageCleanTmp and
  // is consumed by an explicit result-fetch, never listed in the gallery.
  if (temp) return;
  const { readImageSidecar } = await import('../imageGen/local.js');
  const { metadata } = await readImageSidecar(filename);
  // Mirror listGallery's entry shape (filename + path + spread sidecar). One
  // intentional gap: listGallery synthesizes createdAt from the file birthtime
  // when the sidecar lacks one (e.g. external/SD-mode images write no sidecar);
  // the hook has no stat here, so a sidecar-less image's createdAt falls back to
  // `now` in imageToRow and is corrected on the next boot reconcile (which is
  // the source of truth for createdAt). Cosmetic: only the sort key jitters.
  const row = imageToRow({ filename, path: `/data/images/${filename}`, ...metadata });
  await upsertAsset(row).catch((err) => console.error(`❌ Media index image upsert failed: ${err.message}`));
}

// Index a single just-generated video. The 'completed' event carries the job
// id (generationId); the full metadata is the matching video-history entry.
async function onVideoCompleted({ generationId } = {}) {
  if (typeof generationId !== 'string' || !generationId) return;
  const { loadHistory } = await import('../videoGen/local.js');
  const history = await loadHistory().catch(() => []);
  const entry = Array.isArray(history) ? history.find((h) => h.id === generationId) : null;
  if (!entry) return;
  const row = videoToRow(entry);
  await upsertAsset(row).catch((err) => console.error(`❌ Media index video upsert failed: ${err.message}`));
}

// Drop one row, non-fatally. The delete paths call this AFTER the file is
// already gone, so a failure here must never surface to the user — the row just
// lingers until the next boot reconcile prunes it, i.e. exactly the old
// behavior. Skipped under the escape hatch, where there's no index to maintain.
async function unindexKey(mediaKey, kind) {
  if (!mediaKey || isEscapeHatch()) return;
  await removeAsset(mediaKey).catch((err) => console.error(`❌ Media index ${kind} remove failed: ${err.message}`));
}

/**
 * Drop a deleted image's row. `filename` is the gallery filename — the same ref
 * onImageCompleted indexed it under, so the key matches the row that was written.
 * Never throws.
 */
export async function unindexImage(filename) {
  await unindexKey(imageMediaKey(filename), 'image');
}

/**
 * Drop a deleted video's row. `id` is the job id (NOT the filename) — the same
 * ref onVideoCompleted indexed it under. Never throws.
 */
export async function unindexVideo(id) {
  await unindexKey(videoMediaKey(id), 'video');
}

/**
 * Boot init: subscribe the completed-hooks (once) + run a full reconcile.
 * No-op under the escape hatch or when Postgres is unreachable (the boot DB
 * gate already fail-fasts a required-but-missing DB; this just stays quiet).
 */
export async function initMediaAssetIndex() {
  if (isEscapeHatch()) {
    console.log('🗂️  Media asset index disabled (escape hatch / test) — serving from disk only');
    return { ok: false, reason: 'escape-hatch' };
  }
  const health = await checkHealth();
  if (!health.connected) return { ok: false, reason: 'db-unreachable' };
  // Self-sufficient like the CD backend: ensureSchema is idempotent + in-flight
  // deduped, so calling it here is safe regardless of boot ordering.
  await ensureSchema();

  if (!subscribed) {
    // The completed handlers run outside the request lifecycle (event emitter),
    // so an uncaught throw would crash Node — each handler is self-contained and
    // its upsert .catch()es. Wrap the dispatch too, defensively.
    imageGenEvents.on('completed', (p) => { onImageCompleted(p).catch((err) => console.error(`❌ Media index image hook: ${err.message}`)); });
    videoGenEvents.on('completed', (p) => { onVideoCompleted(p).catch((err) => console.error(`❌ Media index video hook: ${err.message}`)); });
    subscribed = true;
  }

  return reconcileMediaAssets();
}
