/**
 * Media asset index — public entry / boot wiring (#1000).
 *
 * The index is a DERIVED Postgres mirror of on-disk media (see db.js). This
 * module owns its lifecycle:
 *   - initMediaAssetIndex() — awaited once at boot (after the DB gate). Ensures
 *     the schema and subscribes to the existing image/video `completed` events
 *     so a freshly generated asset is indexed immediately. It does NOT sweep the
 *     library: that is the slowest part of boot and grows with it (#16556).
 *   - reconcileMediaAssetIndexAtBoot() — fire-and-forget after `listen()`. Runs
 *     the full reconcile (so the index matches disk regardless of events missed
 *     while the server was down) and the restored-media tombstone check. Until it
 *     finishes the gallery serves the previous boot's rows, then open list views
 *     get a refetch notice; every write goes through queueMediaIndexRefresh, so a
 *     live hook cannot interleave with it.
 *   - unindexImage() / unindexVideo() — the delete-side mirror of those hooks,
 *     called by the media delete paths so a row dies with its file (#2738).
 *   - The reconcile + row I/O live in db.js; the pure transforms in logic.js.
 *
 * No hot-path generator edits: we hang off the `imageGenEvents` /
 * `videoGenEvents` 'completed' emitters that already fire on every render. The
 * handlers read the just-written sidecar / history entry and upsert one row.
 *
 * Escape hatch: under MEMORY_BACKEND=file or a test runner there's no Postgres,
 * so the index is simply not maintained — the gallery/history still serve from
 * disk. init() no-ops in that case (mirrors how catalog features disable).
 */

import { isFileBackend } from '../../lib/pgFileFacade.js';
import { checkHealth, ensureSchema } from '../../lib/db.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { videoGenEvents } from '../videoGen/events.js';
import { upsertAsset, removeAsset, reconcileMediaAssets, queueMediaIndexRefresh } from './db.js';
import { imageMediaKey, imageToRow, videoMediaKey, videoToRow } from './logic.js';

export { reconcileMediaAssets } from './db.js';

let subscribed = false;
// Armed by a successful init and consumed by the post-listen sweep, so the sweep
// runs once per boot and never on a boot whose init bailed (escape hatch, DB
// unreachable, an earlier migration step threw).
let bootReconcilePending = false;

// Index a single just-generated image. The 'completed' event carries the
// filename; the full metadata is in the sidecar the generator just wrote.
export async function indexImage({ filename, temp } = {}) {
  if (isFileBackend()) return;
  if (typeof filename !== 'string' || !filename) return;
  // A non-gallery temp render (issue #2264, Image Cleaner GPU pass) has no
  // gallery file or sidecar — skip indexing it. It lives in imageCleanTmp and
  // is consumed by an explicit result-fetch, never listed in the gallery.
  if (temp) return;
  return queueMediaIndexRefresh(async () => {
    const { readImageSidecar } = await import('../imageGen/local.js');
    const { metadata } = await readImageSidecar(filename);
    // Match disk gallery's timestamp fallback for uploads without a sidecar.
    let createdAt = metadata.createdAt;
    if (!createdAt) {
      const [{ stat }, { join }, { PATHS }] = await Promise.all([
        import('node:fs/promises'), import('node:path'), import('../../lib/fileUtils.js'),
      ]);
      createdAt = (await stat(join(PATHS.images, filename))).birthtime.toISOString();
    }
    const row = imageToRow({ filename, path: `/data/images/${filename}`, createdAt, ...metadata });
    await upsertAsset(row).catch((err) => console.error(`❌ Media index image upsert failed: ${err.message}`));
  });
}

// Index the just-generated video(s). The 'completed' event carries the job id
// (generationId); the full metadata is the matching video-history entry. A
// multi-format HTML composition (#8960) registers one entry per format and
// lists their ids in `videos`, none of which is the job id itself.
async function onVideoCompleted({ generationId, videos } = {}) {
  const ids = Array.isArray(videos) ? videos.map((video) => video?.id) : [generationId];
  const wanted = new Set(ids.filter((id) => typeof id === 'string' && id));
  if (!wanted.size) return;
  return queueMediaIndexRefresh(async () => {
    const { loadHistory } = await import('../videoGen/history.js');
    const history = await loadHistory().catch(() => []);
    const entries = Array.isArray(history) ? history.filter((h) => wanted.has(h.id)) : [];
    for (const entry of entries) {
      await upsertAsset(videoToRow(entry)).catch((err) => console.error(`❌ Media index video upsert failed: ${err.message}`));
    }
  });
}

// Post-delete hooks tolerate index failure until boot reconciliation. A caller
// retaining its history row and bytes can use strict removal to fail closed.
// Test/file backends have no derived Postgres index to maintain.
async function unindexKey(mediaKey, kind, { strict = false } = {}) {
  if (!mediaKey || isFileBackend()) return;
  const removal = queueMediaIndexRefresh(() => removeAsset(mediaKey));
  if (strict) return removal;
  await removal.catch((err) => console.error(`❌ Media index ${kind} remove failed: ${err.message}`));
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
 * Drop a video's row. `id` is the job id (NOT the filename).
 * `strict` propagates failure when a caller still holds the history entry and
 * bytes for a retry; ordinary post-delete hooks remain non-fatal.
 */
export async function unindexVideo(id, options = {}) {
  await unindexKey(videoMediaKey(id), 'video', options);
}

/**
 * Boot init: ensure the schema + subscribe the completed-hooks (once), then arm
 * the post-listen sweep. No-op under the escape hatch or when Postgres is
 * unreachable (the boot DB gate already fail-fasts a required-but-missing DB;
 * this just stays quiet).
 */
export async function initMediaAssetIndex() {
  if (isFileBackend()) {
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
    imageGenEvents.on('completed', (p) => { indexImage(p).catch((err) => console.error(`❌ Media index image hook: ${err.message}`)); });
    videoGenEvents.on('completed', (p) => { onVideoCompleted(p).catch((err) => console.error(`❌ Media index video hook: ${err.message}`)); });
    subscribed = true;
  }
  bootReconcilePending = true;
  return { ok: true };
}

/**
 * The boot sweep, run fire-and-forget after `listen()`. Never rejects: each half
 * logs its own failure, and a failed reconcile still lets the tombstone check run
 * (it reads disk, not the index). Resolves to the reconcile result, or a
 * `{ ok: false, reason }` when init never armed it or it already ran this boot.
 */
export async function reconcileMediaAssetIndexAtBoot() {
  if (!bootReconcilePending) return { ok: false, reason: 'not-armed' };
  bootReconcilePending = false;
  const result = await reconcileMediaAssets().catch((err) => {
    console.error(`❌ Media asset index boot reconcile failed: ${err.message}`);
    return { ok: false, reason: 'reconcile-failed' };
  });
  // A gallery opened before the sweep finished read the previous boot's rows and
  // does not poll, so tell open list views to refetch. Queued, not emitted
  // directly: a render that completed mid-sweep has its row write waiting behind
  // the sweep, and its own completion event already reached the client, so a
  // notice ahead of that write would be the last refresh and miss it.
  if (result.ok) {
    await queueMediaIndexRefresh(async () => {
      const { emitMediaListChanged } = await import('../peerSyncEventBus.js');
      emitMediaListChanged('image');
      emitMediaListChanged('video');
    }).catch((err) => console.error(`❌ Media index boot refresh notice failed: ${err.message}`));
  }
  // Put Back from the OS Trash restores files with no PortOS event; this boot
  // pass is where a locally owned item that came back sheds its delete record.
  await import('../mediaRestoreTombstones.js')
    .then((m) => m.clearRestoredMediaTombstones())
    .catch((err) => console.error(`❌ Restored media delete-record check failed: ${err.message}`));
  return result;
}
