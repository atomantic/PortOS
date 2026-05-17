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
    // Release the reference once this write is no longer the tail so settled
    // promises (and their resolved payloads) don't linger for the process life.
    const silenced = next.catch(() => {});
    tail = silenced;
    silenced.finally(() => {
      if (tail === silenced) tail = Promise.resolve();
    });
    return next; // callers see the real resolve/reject
  };
}
