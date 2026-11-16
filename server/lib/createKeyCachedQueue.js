/**
 * Per-KEY serialized async work queue (sibling to `fileWriteQueue.js`'s single tail).
 *
 * `createKeyCachedQueue()` returns `queue(key, work)` that chains each `work` thunk onto the prior
 * in-flight promise for that `key` — same-key work runs one-after-another (later sees earlier's
 * committed result), different keys run concurrently. Self-pruning tail Map; `work` runs on both
 * fulfil and reject so one failure can't stall the chain; carries `.clear()` for test reset. Used by
 * the media-job completion hooks (writers-room / catalog / music-video scene-image attach) to
 * serialize per-record.
 */

export function createKeyCachedQueue() {
  const tails = new Map();

  function queue(key, work) {
    const prev = tails.get(key) || Promise.resolve();
    // Run `work` on both fulfil AND reject so a prior failure doesn't stall the chain.
    const next = prev.then(work, work);
    tails.set(key, next);
    // Evict once settled unless something newer chained on; swallowed so eviction can't be an unhandled rejection.
    const evict = () => { if (tails.get(key) === next) tails.delete(key); };
    next.then(evict, evict);
    return next;
  }

  queue.clear = () => tails.clear();
  return queue;
}
