/**
 * World Builder — collection hook.
 *
 * Subscribes to mediaJobEvents and, for each completed image job that
 * carries `params.worldRun.collectionId`, files the rendered filename
 * into that collection.
 *
 * Mounted once at server boot from server/index.js so it can listen for
 * the lifetime of the process. Failures here are logged but never thrown
 * — a bookkeeping miss must not crash the server or fail the user's
 * render.
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { addItem, ERR_DUPLICATE } from './mediaCollections.js';

let registeredHandler = null;

export function initWorldBuilderCollectionHook() {
  // Idempotent: a stray double-init (test reload, future refactor) would
  // otherwise register two listeners and double-file every completed image.
  if (registeredHandler) return;

  // EventEmitter does not await async listeners and does not catch their
  // rejections — any throw here would surface as an unhandled promise
  // rejection (process-killing on Node ≥15). Use a sync listener that
  // launches an async IIFE with a top-level catch so this bookkeeping
  // miss can never crash the server or fail the user's render.
  registeredHandler = (job) => {
    void (async () => {
      if (!job || job.kind !== 'image') return;
      const tag = job.params?.worldRun;
      if (!tag?.collectionId) return;
      const filename = job.result?.filename;
      if (!filename || typeof filename !== 'string') return;
      const status = await addItem(tag.collectionId, { kind: 'image', ref: filename })
        .then(() => 'added')
        .catch((err) => {
          // A duplicate (same filename rendered twice in the same run) is
          // expected when batchPerVariation > 1 and the gen output collides.
          if (err?.code === ERR_DUPLICATE) return 'duplicate';
          console.log(`⚠️ world-builder collection hook failed for ${filename}: ${err?.message || String(err)}`);
          return 'failed';
        });
      if (status === 'added') {
        console.log(`🌍 world-builder run=${tag.runId?.slice(0, 8)} category=${tag.category} → ${filename}`);
      } else if (status === 'duplicate') {
        console.log(`🌍 world-builder run=${tag.runId?.slice(0, 8)} category=${tag.category} duplicate skipped: ${filename}`);
      }
    })().catch((err) => {
      // Last-resort net for synchronous throws (unexpected job shape, etc).
      console.log(`⚠️ world-builder collection hook crashed: ${err?.message || err}`);
    });
  };
  mediaJobEvents.on('completed', registeredHandler);
  console.log('🌍 World Builder collection hook initialized');
}

// Test-only reset hook so suites that re-init can do so cleanly. Removes the
// previously registered listener so re-init doesn't leak handlers.
export const __testing = {
  reset: () => {
    if (registeredHandler) {
      mediaJobEvents.off('completed', registeredHandler);
      registeredHandler = null;
    }
  },
};
