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
import { appendEntryImageRef, getUniverse, ENTRY_REF_KIND } from './universeBuilder.js';
import { readImageSidecar } from './imageGen/local.js';
import { atomicWrite } from '../lib/fileUtils.js';

// runId → { universeId, pending, universePromise? }. Pure in-memory; lost on restart.
// `universePromise` memoizes the universe doc for the lifetime of the batch so
// 160-image runs don't re-read universe-builder.json per completion.
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

// Resolves the entry's canonical name (canon entries carry `.name`; variations
// and sheets carry only the compiled label). Returns null when nothing can be
// resolved — the caller falls back to `tag.label`.
function resolveEntryName(universe, entryRef) {
  if (!universe || !entryRef) return null;
  if (entryRef.kind === ENTRY_REF_KIND.CANON && entryRef.kindKey && entryRef.id) {
    const list = universe[entryRef.kindKey];
    const hit = Array.isArray(list) ? list.find((e) => e?.id === entryRef.id) : null;
    return typeof hit?.name === 'string' ? hit.name : null;
  }
  return null;
}

// Build the universe-context object to merge into the image sidecar. Mirrors
// the migration's contract so new + backfilled renders carry identical shapes.
function buildSidecarPatch({ tag, universe }) {
  const entryRef = tag.entryRef;
  const universeName = typeof universe?.name === 'string' ? universe.name : null;
  const patch = {
    universeId: tag.universeId,
    ...(universeName ? { universeName } : {}),
    ...(tag.runId ? { universeRunId: tag.runId } : {}),
    ...(tag.label ? { entryLabel: tag.label } : {}),
  };
  if (!entryRef) {
    // Legacy variations without stable ids: still tag the universe + label
    // so search can find renders by universe even without entity granularity.
    if (tag.category) patch.entryCategory = tag.category;
    return patch;
  }
  patch.entryKind = entryRef.kind;
  patch.entryId = entryRef.id;
  if (entryRef.kind === ENTRY_REF_KIND.VARIATION && entryRef.categoryKey) {
    patch.entryCategory = entryRef.categoryKey;
  } else if (entryRef.kind === ENTRY_REF_KIND.CANON && entryRef.kindKey) {
    patch.entryCategory = entryRef.kindKey;
  }
  const resolvedName = resolveEntryName(universe, entryRef) || tag.label || null;
  if (resolvedName) patch.entryName = resolvedName;
  return patch;
}

// Read-merge-write the image sidecar with universe context. Only fills keys
// that are currently absent — re-renders of the same filename must not
// silently overwrite an existing tag with a different universe's data.
//
// Skips writeback when the sidecar doesn't exist (empty metadata from
// readImageSidecar's miss path). The PNG-generating code always writes a
// sidecar before the `completed` event fires, so an empty result means the
// PNG itself is missing too — creating a universe-only sidecar in that case
// would leave a stub record with no prompt/seed/model on disk.
async function enrichSidecar(filename, patch) {
  const { path, metadata } = await readImageSidecar(filename);
  if (!metadata || Object.keys(metadata).length === 0) return;
  let changed = false;
  const next = { ...metadata };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) continue;
    if (next[k] === undefined || next[k] === null) {
      next[k] = v;
      changed = true;
    }
  }
  if (!changed) return;
  // Atomic (temp + rename) so concurrent readers — listGallery, the
  // lightbox metadata fetch, or another batch entry — can't observe a
  // mid-truncate empty file.
  await atomicWrite(path, next);
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

      // Append the rendered filename to the source entry's `imageRefs[]` so
      // the Universe Builder can show the latest render as an avatar. Wrapped
      // alongside `addItem` under the same re-export-suppression scope, so a
      // single coalesced emit fires when the run finishes. Best-effort —
      // bookkeeping must never crash the server or fail the user's render.
      const appendEntryRefCall = () => {
        if (!tag.entryRef || !tag.universeId) return Promise.resolve(null);
        return appendEntryImageRef(tag.universeId, tag.entryRef, filename).catch((err) => {
          console.log(`⚠️ universe-builder entry-ref append failed for ${filename}: ${err?.message || String(err)}`);
          return null;
        });
      };

      // Enrich the image's sidecar with universe + entity context so
      // MediaHistory can search for renders by character/place name and the
      // lightbox can show which entity produced the image. The universe doc
      // read is memoized per-run on activeRuns so 160-image batches read the
      // ~700KB universe JSON once, not 160 times. Untracked runs (server
      // restart mid-batch) fall back to a per-completion read — rare and
      // bounded by the remaining job count.
      const enrichSidecarCall = () => {
        if (!tag.universeId) return Promise.resolve(null);
        const entry = tag.runId ? activeRuns.get(tag.runId) : null;
        if (entry && !entry.universePromise) {
          entry.universePromise = getUniverse(tag.universeId).catch(() => null);
        }
        const universePromise = entry?.universePromise || getUniverse(tag.universeId).catch(() => null);
        return universePromise
          .then((universe) => enrichSidecar(filename, buildSidecarPatch({ tag, universe })))
          .catch((err) => {
            console.log(`⚠️ universe-builder sidecar enrich failed for ${filename}: ${err?.message || String(err)}`);
            return null;
          });
      };

      try {
        // When the run is tracked, swallow the per-item emitRecordUpdated so a
        // 160-image batch doesn't fan into 160 debounced re-exports. The final
        // emit below fires once when pending hits zero.
        // The three writes touch independent files (media-collections.json,
        // universe-builder.json, the per-image sidecar) and have no ordering
        // dependency — fire them in parallel so a large batch doesn't pay
        // the per-completion serialization cost on every job.
        const work = async () => {
          const [s] = await Promise.all([addItemCall(), appendEntryRefCall(), enrichSidecarCall()]);
          return s;
        };
        const status = runActive && tag.universeId
          ? await withReexportSuppressed('universe', tag.universeId, work)
          : await work();

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
