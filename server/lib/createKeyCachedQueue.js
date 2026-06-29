/**
 * createKeyCachedQueue — per-key serialized async work queue.
 *
 * Returns a `queue(key, work)` function that chains each `work` thunk onto the
 * prior in-flight promise for that `key`, so two operations on the SAME key run
 * one-after-another (the later one sees the earlier one's committed result)
 * while different keys still run concurrently. The classic use is the media-job
 * completion hooks (writers-room / catalog / music-video scene-image attach):
 * two renders for the same record completing close together would otherwise both
 * load→modify→save that record and the later write would clobber the earlier.
 *
 * The in-memory tail Map is self-pruning: each chained promise registers an
 * eviction that removes its key only if nothing newer has chained on, so the Map
 * never grows unbounded. Eviction errors are swallowed (the caller attaches its
 * own `.catch` to the returned promise), and `work` runs on both fulfil AND
 * reject of the prior link so one failure can't stall the whole chain.
 *
 * Lost on restart, which is fine for the best-effort bookkeeping it serializes.
 *
 * The returned function carries a `.clear()` for test reset (drop all tails).
 */
export function createKeyCachedQueue() {
  const tails = new Map();

  function queue(key, work) {
    const prev = tails.get(key) || Promise.resolve();
    // Run `work` on both fulfil AND reject so a prior failure doesn't stall the chain.
    const next = prev.then(work, work);
    tails.set(key, next);
    // Evict once settled, but only if nothing newer has chained on. Swallow here
    // so eviction can't surface as an unhandled rejection — the caller attaches
    // its own `.catch` to the returned promise.
    const evict = () => { if (tails.get(key) === next) tails.delete(key); };
    next.then(evict, evict);
    return next;
  }

  queue.clear = () => tails.clear();
  return queue;
}
