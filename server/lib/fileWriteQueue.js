/**
 * File Write Queue — single-tail promise chain for serializing writes
 * against a shared JSON state file.
 *
 * Every PortOS service that owns a single JSON state file (issues, series,
 * mediaCollections, universeBuilder, …) needs the same guarantee: a
 * `readState → modify → writeState` cycle must not interleave with another
 * cycle on the same file, or one writer's pre-image read overwrites the
 * other's just-persisted record. CLAUDE.md: "Async PATCH races on shared
 * records — serialize writes server-side… collapse the queue to a single
 * tail per shared file."
 *
 * Usage:
 *   import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
 *   const queueWrite = createFileWriteQueue();
 *   // inside each mutator:
 *   return queueWrite(async () => {
 *     const state = await readState();
 *     // ... modify ...
 *     await writeState(state);
 *     return result;
 *   });
 *
 * The queue is per-file (per service module), not per-record — two writes
 * to different ids in the same JSON still race. Create one queue per state
 * file at module scope.
 */
export function createFileWriteQueue() {
  let tail = Promise.resolve();
  return function queue(fn) {
    const next = tail.then(fn, fn); // run fn even when prev rejects
    // Silenced tail prevents a rejection from poisoning subsequent waiters.
    const silenced = next.catch(() => {});
    tail = silenced;
    // When this write settles AND nothing else has chained onto it (i.e. it's
    // still the current tail), reset the tail to a fresh resolved promise so
    // the settled promise (and its resolved payload) can be GC'd. If another
    // write has already enqueued, `tail` points at that newer silenced
    // promise — the equality check is false and we leave it alone.
    silenced.finally(() => {
      if (tail === silenced) tail = Promise.resolve();
    });
    return next; // callers see the real resolve/reject
  };
}

/**
 * Per-RECORD write queue — the id-keyed sibling of `createFileWriteQueue`.
 *
 * Two read-modify-write cycles on the SAME id serialize (the later one sees the
 * earlier one's committed result); cycles on DIFFERENT ids fan out in parallel.
 * This is the queue the PG/file store facades use so their writes serialize
 * identically to `collectionStore.queueRecordWrite` on either backend. The tail
 * Map self-prunes so it stays bounded.
 *
 * @param {(id: string) => void} [assertId] Optional per-id validator, invoked
 *   before queueing (throws on a bad id, exactly as the callers' inline guards
 *   did — so a malformed id rejects synchronously rather than being enqueued).
 *
 * Usage:
 *   const queueRecordWrite = createRecordWriteQueue(assertValidId);
 *   queueRecordWrite(id, () => saveOneNow(id, record));
 */
export function createRecordWriteQueue(assertId) {
  const tails = new Map();
  return function queueRecordWrite(id, fn) {
    if (assertId) assertId(id);
    const prev = tails.get(id) || Promise.resolve();
    const next = prev.then(fn, fn); // run fn even when prev rejects
    const silenced = next.catch(() => {});
    tails.set(id, silenced);
    silenced.finally(() => { if (tails.get(id) === silenced) tails.delete(id); });
    return next; // callers see the real resolve/reject
  };
}
