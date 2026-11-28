/**
 * Serialize read-modify-write cycles so they don't interleave.
 */

import { createKeyCachedQueue } from './createKeyCachedQueue.js';

/**
 * Single-tail promise chain serializing `readState -> modify -> writeState` cycles on a shared JSON
 * state file, so one writer's pre-image read can't overwrite another's just-persisted record.
 *
 * Usage: `const queueWrite = createFileWriteQueue(); return queueWrite(async () => { ...read, modify, write... });`
 *
 * The queue is per-file, not per-record: writes to different ids in the same JSON still race.
 * Create one queue per state file at module scope.
 */
export function createFileWriteQueue() {
  let tail = Promise.resolve();
  return function queue(fn) {
    const next = tail.then(fn, fn); // run fn even when prev rejects
    // Silenced tail keeps a rejection from poisoning later waiters.
    const silenced = next.catch(() => {});
    tail = silenced;
    // Reset a still-current tail so the settled promise (and payload) can be GC'd; a newer tail is left alone.
    silenced.finally(() => {
      if (tail === silenced) tail = Promise.resolve();
    });
    return next; // callers see the real resolve/reject
  };
}

/**
 * Per-RECORD write queue, the id-keyed sibling of `createFileWriteQueue`: cycles on the SAME id
 * serialize, different ids fan out. Thin wrapper over `createKeyCachedQueue` (self-pruning tail Map)
 * adding an optional synchronous id validator, so a malformed id rejects before being enqueued.
 *
 * @param {(id: string) => void} [assertId] throws on a bad id
 */
export function createRecordWriteQueue(assertId) {
  const queue = createKeyCachedQueue();
  return function queueRecordWrite(id, fn) {
    if (assertId) assertId(id);
    return queue(id, fn); // callers see the real resolve/reject
  };
}

/**
 * Keyed file-write queue: one JSON state file per key (series/issue) serializes per key while
 * different keys fan out, via `createKeyCachedQueue`. Falsy / non-string keys share an
 * `'__unknown__'` tail.
 */
export function createKeyedFileWriteQueue() {
  const queue = createKeyCachedQueue();
  return function queueKeyedWrite(key, fn) {
    const safeKey = typeof key === 'string' && key ? key : '__unknown__';
    return queue(safeKey, fn); // callers see the real resolve/reject
  };
}

/**
 * Drain parallel work before an exclusive operation and defer new work until
 * it finishes. A work callback must not await another turn on the same fence.
 */
export function createFileWorkFence() {
  const active = new Set();
  const queueExclusive = createFileWriteQueue();
  let held = null;

  async function run(work) {
    while (held) await held;
    const pending = Promise.resolve().then(work);
    active.add(pending);
    try {
      return await pending;
    } finally {
      active.delete(pending);
    }
  }

  const exclusive = (work) => queueExclusive(async () => {
    const { promise, resolve } = Promise.withResolvers();
    held = promise;
    try {
      await Promise.allSettled(active);
      return await work();
    } finally {
      held = null;
      resolve();
    }
  });

  return { run, exclusive };
}

/**
 * Detached writes (bookkeeping scheduled off a queued turn and not awaited) still need one drain
 * point for test teardown or shutdown. The registry lives on `globalThis` so module instances from
 * `vi.resetModules()` share it; entries remove themselves on settle.
 */
const DETACHED_WRITES = Symbol.for('portos.detachedWrites');
const detachedWrites = globalThis[DETACHED_WRITES] ??= new Set();

/** Track a detached write's promise; the caller still owns its rejection. */
export function trackDetachedWrite(promise) {
  detachedWrites.add(promise);
  const release = () => detachedWrites.delete(promise);
  promise.then(release, release);
  return promise;
}

/** Await every detached write tracked so far, including ones scheduled meanwhile. */
export async function drainDetachedWrites() {
  while (detachedWrites.size) await Promise.allSettled([...detachedWrites]);
}
