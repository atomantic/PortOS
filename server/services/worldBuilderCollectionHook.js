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

export function initWorldBuilderCollectionHook() {
  // EventEmitter does not await async listeners and does not catch their
  // rejections — any throw here would surface as an unhandled promise
  // rejection (process-killing on Node ≥15). Use a sync listener that
  // launches an async IIFE with a top-level catch so this bookkeeping
  // miss can never crash the server or fail the user's render.
  mediaJobEvents.on('completed', (job) => {
    void (async () => {
      if (!job || job.kind !== 'image') return;
      const tag = job.params?.worldRun;
      if (!tag?.collectionId) return;
      const filename = job.result?.filename;
      if (!filename || typeof filename !== 'string') return;
      const added = await addItem(tag.collectionId, { kind: 'image', ref: filename })
        .then(() => true)
        .catch((err) => {
          // A duplicate (same filename rendered twice in the same run) is
          // expected when batchPerVariation > 1 and the gen output collides;
          // anything else is a real bookkeeping miss worth logging.
          if (err?.code === ERR_DUPLICATE) return true;
          console.log(`⚠️ world-builder collection hook failed for ${filename}: ${err.message}`);
          return false;
        });
      if (added) {
        console.log(`🌍 world-builder run=${tag.runId?.slice(0, 8)} category=${tag.category} → ${filename}`);
      }
    })().catch((err) => {
      // Last-resort net for synchronous throws (unexpected job shape, etc).
      console.log(`⚠️ world-builder collection hook crashed: ${err?.message || err}`);
    });
  });
  console.log('🌍 World Builder collection hook initialized');
}
