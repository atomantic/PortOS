// `evictOldest(map, max, onEvict?)` evicts oldest-first until a Map is within `max`, with an optional per-evicted-key teardown callback for a companion timer map.
//
// Also `ORPHAN_BUFFER_MAX` (64), the shared cap for the orphan-event race-buffers: the one home for the "stash an unmatched event in a `jobId → …` Map, evict the oldest on overflow" idiom used by
// `useSceneRenderLifecycle` (orphan-terminal buffer), `useImageGenQueue` (orphan-event buffer plus a companion TTL map) and `clientErrorReporter` (error-dedup cache) (#1803). Callers wanting LRU refresh a touched entry by `delete()` + `set()` before writing.

// Shared cap for the orphan race-buffers: the max not-yet-correlated jobIds to buffer before evicting the oldest, so unrelated global media-job events can't grow the buffer unbounded (the error-dedup cache keeps its own `MAX_RECENT`).
export const ORPHAN_BUFFER_MAX = 64;

/**
 * Evict the oldest entries from `map` until `map.size <= max` (Map iteration order is insertion order, so `map.keys().next().value` is the oldest). `onEvict(key)` runs for each removed key, e.g. to clear a TTL timer in a parallel Map.
 * Returns the number evicted; no-op within budget. The `undefined`-key break guards a map that empties mid-loop.
 */
export function evictOldest(map, max, onEvict) {
  let evicted = 0;
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
    if (onEvict) onEvict(oldest);
    evicted += 1;
  }
  return evicted;
}
