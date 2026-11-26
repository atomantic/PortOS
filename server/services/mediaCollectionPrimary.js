/**
 * Collection-wide orchestration of verified per-file primary changes. The
 * assignment persists only on a real collection. The run is transient and repeatable;
 * the holders service persists any offline releases it accepted.
 *
 * Two scopes are not collections and persist nothing: `unsorted` (every gallery
 * file outside a collection) and `shared-media` (every file more than one
 * machine holds, filed or not; a file only one machine holds is left alone).
 */
import { randomUUID } from 'node:crypto';
import { ServerError } from '../lib/errorHandler.js';
import { getCollection, setCollectionPrimaryMachine } from './mediaCollections.js';
import { listMediaHolders, listMediaPrimaryMachines, prepareMediaConsolidation } from './mediaHolders.js';
import { emitCollectionPrimaryChanged } from './peerSyncEventBus.js';
import { loadCollectionVideoFilenames, resolveCollectionVideoFilename } from './collectionVideoFiles.js';

const UNSORTED_ID = 'unsorted';
export const SHARED_MEDIA_ID = 'shared-media';
const ONE_SHOT_IDS = new Set([UNSORTED_ID, SHARED_MEDIA_ID]);

async function listSharedMediaFiles() {
  const { items } = await listMediaHolders();
  return Object.values(items).filter((item) => item.holders.length > 1).map(({ kind, filename }) => ({ kind, filename }));
}
const active = new Map();
const lastRuns = new Map();
const MAX_RECENT_RUNS = 100;
const MAX_DETAILS = 10;

export async function getCollectionPrimaryStatus(id) {
  const [collection, machines] = await Promise.all([ONE_SHOT_IDS.has(id) ? null : getCollection(id), listMediaPrimaryMachines()]);
  return { instanceId: collection?.primaryInstanceId ?? null, machines, run: active.get(id)?.run ?? lastRuns.get(id) ?? null };
}

export function cancelCollectionPrimary(id, runId) {
  const current = active.get(id);
  if (!current || (runId && runId !== current.run.runId)) return false;
  if (!current.controller.signal.aborted) {
    current.run.cancelling = true;
    current.controller.abort();
    emitCollectionPrimaryChanged(id);
  }
  return { ok: true, runId: current.run.runId };
}

function finishRun(id, { run, controller }) {
  run.running = false;
  run.cancelling = false;
  run.canceled = controller.signal.aborted;
  active.delete(id);
  // Only completed runs are retained here; an active run lives in its own map.
  lastRuns.delete(id);
  lastRuns.set(id, run);
  if (lastRuns.size > MAX_RECENT_RUNS) lastRuns.delete(lastRuns.keys().next().value);
  emitCollectionPrimaryChanged(id);
}

async function consolidate(id, entries, move, current) {
  const { run, controller } = current;
  run.total = entries.length;
  emitCollectionPrimaryChanged(id);
  const addDetail = (entry, message) => {
    if (run.details.length < MAX_DETAILS) run.details.push({ filename: entry.filename, message });
  };
  try {
    for (const entry of entries) {
      // Let the current file finish verifying its primary copy and settling
      // releases before stopping; that file is the consistency boundary.
      if (controller.signal.aborted) break;
      try {
        const { released, pending, kept } = await move(entry);
        run.completed++;
        run.released += released.length;
        run.pending += pending.length;
        run.kept += kept.length;
        for (const { name, reason } of kept) addDetail(entry, `${name}: ${reason}`);
      } catch (err) {
        run.failed++;
        // Unexpected filesystem/storage failures may carry machine-local paths.
        addDetail(entry, err instanceof ServerError && err.status < 500 ? err.message : 'Could not finish moving this item. Check the server logs and retry.');
        if (!(err instanceof ServerError) || err.status >= 500) {
          console.error(`❌ Collection primary failed for ${entry.kind}: ${err.code || err.name}`);
        }
      }
    }
  } finally {
    finishRun(id, current);
  }
}

export async function startCollectionPrimary(id, instanceId) {
  const holder = active.get(id);
  if (holder) throw new ServerError('This collection is already consolidating', { status: 409, code: 'MEDIA_BUSY', context: { runId: holder.run.runId } });
  const controller = new AbortController();
  const run = {
    runId: randomUUID(), running: true, cancelling: false, canceled: false,
    total: 0, completed: 0, released: 0, pending: 0, kept: 0, failed: 0, details: [],
  };
  const current = { controller, run };
  active.set(id, current);
  emitCollectionPrimaryChanged(id);
  const startRun = (entries, move) => {
    void consolidate(id, entries, move, current).catch((err) => {
      console.error(`❌ Collection primary job failed: ${err.code || err.name}`);
    });
    return { instanceId, run };
  };
  try {
    if (id === UNSORTED_ID) {
      const { listUnsortedGalleryFiles } = await import('./mediaAssetIndex/gallery.js');
      controller.signal.throwIfAborted();
      const move = await prepareMediaConsolidation(instanceId);
      controller.signal.throwIfAborted();
      const entries = await listUnsortedGalleryFiles();
      return startRun(entries, move);
    }
    if (id === SHARED_MEDIA_ID) {
      controller.signal.throwIfAborted();
      const move = await prepareMediaConsolidation(instanceId);
      controller.signal.throwIfAborted();
      return startRun(await listSharedMediaFiles(), move);
    }
    const collection = await getCollection(id);
    controller.signal.throwIfAborted();
    const [move, videoNames] = await Promise.all([
      prepareMediaConsolidation(instanceId),
      loadCollectionVideoFilenames(collection.items),
    ]);
    controller.signal.throwIfAborted();
    if (!videoNames) throw new ServerError('Video history is temporarily unavailable', { status: 503 });
    const entries = new Map();
    for (const { kind, ref } of collection.items) {
      const filename = kind === 'video' ? resolveCollectionVideoFilename(ref, videoNames) : ref;
      entries.set(`${kind}:${filename ?? ref}`, { kind, filename });
    }
    await setCollectionPrimaryMachine(id, instanceId);
    return startRun([...entries.values()], move);
  } catch (err) {
    if (controller.signal.aborted) {
      finishRun(id, current);
      return { instanceId, run };
    }
    active.delete(id);
    emitCollectionPrimaryChanged(id);
    throw err;
  }
}
