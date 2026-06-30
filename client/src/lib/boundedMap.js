// Bounded race-buffer eviction (#1803). Three client race-buffers each
// hand-rolled the same idiom: stash an unmatched event in a `jobId → …` Map,
// then evict the oldest entry once the Map overflows a hard cap. Map iteration
// order is insertion order, so `map.keys().next().value` is always the oldest
// surviving key — `delete()`-ing it is the cheap "evict oldest" primitive.
// Callers that want LRU semantics refresh a touched entry by `delete()` +
// `set()` before writing, moving it to the newest position so it survives the
// next eviction.
//
// Call sites routed through here:
//   - useSceneRenderLifecycle.js (orphan-terminal buffer)
//   - useImageGenQueue.js        (orphan-event buffer, plus a companion TTL map)
//   - clientErrorReporter.js     (error-dedup hash cache)

// Shared cap for the orphan race-buffers: the max number of distinct
// not-yet-correlated jobIds to buffer before evicting the oldest. Without it,
// unrelated global media-job events from elsewhere in the app would grow the
// buffer unbounded on a long-lived session. (The error-dedup cache keeps its
// own `MAX_RECENT` — a separate tuning knob — but shares the eviction logic.)
export const ORPHAN_BUFFER_MAX = 64;

/**
 * Evict the oldest entries from `map` until `map.size <= max`. Map iteration
 * order is insertion order, so `map.keys().next().value` is the oldest
 * surviving key. `onEvict(key)` (optional) runs for each removed key — use it
 * to tear down a companion per-entry resource (e.g. clear a TTL timer held in
 * a parallel timers Map). Returns the number of entries evicted.
 *
 * No-op when already within budget. The `undefined`-key break defensively
 * guards a map that empties mid-loop (size > max already implies a key exists).
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
