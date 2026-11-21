/**
 * Collection-wide orchestration of verified per-file primary changes. The
 * assignment persists on the collection. The run is transient and repeatable;
 * the holders service persists any offline releases it accepted.
 */
import { ServerError } from '../lib/errorHandler.js';
import { getCollection, setCollectionPrimaryMachine } from './mediaCollections.js';
import { listMediaPrimaryMachines, prepareMediaConsolidation } from './mediaHolders.js';
import { emitCollectionPrimaryChanged } from './peerSyncEventBus.js';
import { loadCollectionVideoFilenames, resolveCollectionVideoFilename } from './collectionVideoFiles.js';

const active = new Set();
const lastRuns = new Map();
const MAX_RECENT_RUNS = 100;
const MAX_DETAILS = 10;

export async function getCollectionPrimaryStatus(id) {
  const [collection, machines] = await Promise.all([getCollection(id), listMediaPrimaryMachines()]);
  return { instanceId: collection.primaryInstanceId ?? null, machines, run: lastRuns.get(id) ?? null };
}

async function consolidate(id, entries, move) {
  const run = { running: true, total: entries.length, completed: 0, released: 0, pending: 0, kept: 0, failed: 0, details: [] };
  lastRuns.set(id, run);
  emitCollectionPrimaryChanged(id);
  const addDetail = (entry, message) => {
    if (run.details.length < MAX_DETAILS) run.details.push({ filename: entry.filename, message });
  };
  try {
    for (const entry of entries) {
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
    run.running = false;
    active.delete(id);
    // Bound completed summaries without evicting an active operation.
    for (const [key, previous] of lastRuns) {
      if (lastRuns.size <= MAX_RECENT_RUNS) break;
      if (!previous.running) lastRuns.delete(key);
    }
    emitCollectionPrimaryChanged(id);
  }
}

export async function startCollectionPrimary(id, instanceId) {
  if (active.has(id)) throw new ServerError('This collection is already consolidating', { status: 409, code: 'MEDIA_BUSY' });
  active.add(id);
  try {
    const collection = await getCollection(id);
    const [move, videoNames] = await Promise.all([
      prepareMediaConsolidation(instanceId),
      loadCollectionVideoFilenames(collection.items),
    ]);
    if (!videoNames) throw new ServerError('Video history is temporarily unavailable', { status: 503 });
    const entries = new Map();
    for (const { kind, ref } of collection.items) {
      const filename = kind === 'video' ? resolveCollectionVideoFilename(ref, videoNames) : ref;
      entries.set(`${kind}:${filename ?? ref}`, { kind, filename });
    }
    await setCollectionPrimaryMachine(id, instanceId);
    lastRuns.delete(id);
    consolidate(id, [...entries.values()], move).catch((err) => {
      console.error(`❌ Collection primary job failed: ${err.code || err.name}`);
    });
    return { instanceId, run: lastRuns.get(id) };
  } catch (err) {
    active.delete(id);
    throw err;
  }
}
