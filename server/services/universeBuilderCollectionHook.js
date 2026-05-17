/**
 * Universe Builder — collection hook.
 *
 * Subscribes to mediaJobEvents and, for each completed image job that
 * carries `params.universeRun.collectionId`, files the rendered filename
 * into that collection.
 *
 * Mounted once at server boot from server/index.js so it can listen for
 * the lifetime of the process. Failures here are logged but never thrown
 * — a bookkeeping miss must not crash the server or fail the user's
 * render.
 *
 * Re-export coalescing: when the route calls `registerUniverseBuilderRun`
 * with a job count, every `addItem` for that run is wrapped in
 * `withReexportSuppressed` so the per-image emits don't each schedule a
 * debounced re-export of the whole universe. Once the last job in the run
 * reaches a terminal state (completed/failed/canceled), the hook emits a
 * single `emitRecordUpdated('universe', …)` and the subscription debounces
 * one re-export. Server restart mid-run drops the tracker entry — the
 * hook then falls back to per-image emits (current/legacy behavior) until
 * the run finishes naturally.
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { addItem, ERR_DUPLICATE } from './mediaCollections.js';
import { withReexportSuppressed, emitRecordUpdated } from './sharing/recordEvents.js';

// runId → { universeId, pending }. Pure in-memory; lost on restart.
const activeRuns = new Map();

export function registerUniverseBuilderRun({ runId, universeId, jobCount }) {
  if (!runId || !universeId || !Number.isFinite(jobCount) || jobCount <= 0) return;
  activeRuns.set(runId, { universeId, pending: jobCount });
}

// Returns the run's universeId when this terminal closes the batch (pending → 0),
// otherwise null. Callers use the return value as the "fire the final emit" signal.
function noteTerminal(runId) {
  const entry = activeRuns.get(runId);
  if (!entry) return null;
  entry.pending -= 1;
  if (entry.pending > 0) return null;
  activeRuns.delete(runId);
  return entry.universeId;
}

let completedHandler = null;
let terminalHandler = null;

export function initUniverseBuilderCollectionHook() {
  // Idempotent: a stray double-init (test reload, future refactor) would
  // otherwise register two listeners and double-file every completed image.
  if (completedHandler) return;

  // EventEmitter does not await async listeners and does not catch their
  // rejections — any throw here would surface as an unhandled promise
  // rejection (process-killing on Node ≥15). Use a sync listener that
  // launches an async IIFE with a top-level catch so this bookkeeping
  // miss can never crash the server or fail the user's render.
  completedHandler = (job) => {
    void (async () => {
      if (!job || job.kind !== 'image') return;
      const tag = job.params?.universeRun;
      if (!tag?.collectionId) return;
      const filename = job.result?.filename;
      if (!filename || typeof filename !== 'string') return;

      const runActive = tag.runId ? activeRuns.has(tag.runId) : false;
      const addItemCall = () => addItem(tag.collectionId, { kind: 'image', ref: filename })
        .then(() => 'added')
        .catch((err) => {
          // A duplicate (same filename rendered twice in the same run) is
          // expected when batchPerVariation > 1 and the gen output collides.
          if (err?.code === ERR_DUPLICATE) return 'duplicate';
          console.log(`⚠️ universe-builder collection hook failed for ${filename}: ${err?.message || String(err)}`);
          return 'failed';
        });

      try {
        // When the run is tracked, swallow the per-item emitRecordUpdated so a
        // 160-image batch doesn't fan into 160 debounced re-exports. The final
        // emit below fires once when pending hits zero.
        const status = runActive && tag.universeId
          ? await withReexportSuppressed('universe', tag.universeId, addItemCall)
          : await addItemCall();

        if (status === 'added') {
          console.log(`🌍 universe-builder run=${tag.runId?.slice(0, 8)} category=${tag.category} → ${filename}`);
        } else if (status === 'duplicate') {
          console.log(`🌍 universe-builder run=${tag.runId?.slice(0, 8)} category=${tag.category} duplicate skipped: ${filename}`);
        }
      } finally {
        // `finally` (not the happy path) so an unexpected throw still
        // decrements pending — otherwise one anomaly stalls the run's
        // coalesced emit forever.
        if (tag.runId) {
          const completedUniverseId = noteTerminal(tag.runId);
          if (completedUniverseId) emitRecordUpdated('universe', completedUniverseId);
        }
      }
    })().catch((err) => {
      // Last-resort net for synchronous throws (unexpected job shape, etc).
      console.log(`⚠️ universe-builder collection hook crashed: ${err?.message || err}`);
    });
  };

  // Failed/canceled jobs still count toward run completion — otherwise a
  // single failure mid-batch would leave `pending > 0` forever and the
  // final emit would never fire.
  terminalHandler = (job) => {
    if (!job || job.kind !== 'image') return;
    const tag = job.params?.universeRun;
    if (!tag?.runId) return;
    const completedUniverseId = noteTerminal(tag.runId);
    if (completedUniverseId) emitRecordUpdated('universe', completedUniverseId);
  };

  mediaJobEvents.on('completed', completedHandler);
  mediaJobEvents.on('failed', terminalHandler);
  mediaJobEvents.on('canceled', terminalHandler);
  console.log('🌍 Universe Builder collection hook initialized');
}

// Test-only reset hook so suites that re-init can do so cleanly. Removes the
// previously registered listeners so re-init doesn't leak handlers.
export const __testing = {
  reset: () => {
    if (completedHandler) {
      mediaJobEvents.off('completed', completedHandler);
      completedHandler = null;
    }
    if (terminalHandler) {
      mediaJobEvents.off('failed', terminalHandler);
      mediaJobEvents.off('canceled', terminalHandler);
      terminalHandler = null;
    }
    activeRuns.clear();
  },
  getActiveRuns: () => new Map(activeRuns),
};
