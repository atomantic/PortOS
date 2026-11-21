/**
 * Requested-collection hook: an Image Gen / Video Gen request that carries
 * `collectionName` has its finished render filed into the collection of that
 * name, created on first use. The name rides on the job params so queued,
 * hosted and peer-lane renders all file on completion, not just the one that
 * happened to be dispatched synchronously (`fileIntoRequestedCollection` covers
 * the synchronous image lanes that never emit a queue completion).
 *
 * Best-effort bookkeeping: a failure is logged, never thrown, so a collection
 * problem can't fail a render the user already paid for. Filing is idempotent.
 * Calls for the same name serialize on the lower-cased name so two renders that
 * finish together can't both create the "same" collection (the name-first
 * provisioner does not serialize by name itself).
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { findOrCreateCollectionByName, addItem, ERR_DUPLICATE } from './mediaCollections.js';

const serialize = createKeyCachedQueue();
const inFlight = new Set();
let completedHandler = null;

const requestedTarget = (job) => {
  if (job?.kind !== 'image' && job?.kind !== 'video') return null;
  const name = job.params?.collectionName;
  if (typeof name !== 'string' || !name.trim()) return null;
  const ref = job.kind === 'image' ? job.result?.filename : (job.result?.generationId || job.id);
  if (typeof ref !== 'string' || !ref) return null;
  return { name: name.trim(), item: { kind: job.kind, ref } };
};

/** File one asset into the named collection, creating it if needed. Idempotent. */
export const fileIntoRequestedCollection = (name, item) => serialize(name.trim().toLowerCase(), async () => {
  const collection = await findOrCreateCollectionByName({ name });
  await addItem(collection.id, item).catch((err) => {
    if (err?.code !== ERR_DUPLICATE) throw err;
  });
  return collection.id;
});

export function initRequestedCollectionHook() {
  if (completedHandler) return;
  completedHandler = (job) => {
    const target = requestedTarget(job);
    if (!target) return;
    const handled = withBackupAssetPublication(() => fileIntoRequestedCollection(target.name, target.item))
      .catch((err) => console.error(`❌ requested-collection hook failed for "${target.name}": ${err?.message || err}`));
    inFlight.add(handled);
    handled.finally(() => inFlight.delete(handled));
  };
  mediaJobEvents.on('completed', completedHandler);
  console.log('🗂️ Requested collection hook initialized');
}

export const __testing = {
  reset() {
    if (completedHandler) mediaJobEvents.off('completed', completedHandler);
    completedHandler = null;
    serialize.clear();
  },
  async drain() {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  },
};
