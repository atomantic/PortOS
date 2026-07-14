/**
 * boundedStateMap — a `Map` that self-evicts so a per-key state cache can't
 * grow one entry per key forever.
 *
 * The integration rate-limiters (`integrations/moltbook/rateLimits.js`,
 * `integrations/moltworld/rateLimits.js`) keep an in-memory entry per API key /
 * agent id and never removed idle ones — a long-lived process cycling through
 * many keys leaked one object per key indefinitely. This wraps a `Map` with two
 * bounds, applied lazily on `get`/`set` (no timers):
 *
 *   1. TTL — entries untouched for longer than `ttlMs` are dropped. For the
 *      rate-limiters the useful state (daily counters, cooldown timers) is
 *      already stale after a day, so an idle entry carries nothing worth keeping.
 *   2. LRU cap — if the live set still exceeds `maxSize`, the least-recently
 *      accessed entries are evicted until it fits. Belt-and-suspenders against
 *      pathological key churn within the TTL window.
 *
 * `get` marks access (so it doubles as the LRU touch), mirroring how the
 * rate-limiters call `getState(key)` on every check/record/status. Entries are
 * mutated in place by callers; access tracking lives in a parallel timestamp
 * map so those in-place mutations don't need to round-trip through `set`.
 *
 * @param {Object} [options]
 * @param {number} [options.maxSize=1000] Hard cap on live entries.
 * @param {number} [options.ttlMs=25*60*60*1000] Idle eviction window (default 25h).
 * @returns {{ get, set, has, delete: (k:any)=>boolean, get size(): number, clear }}
 */
export function createBoundedStateMap({ maxSize = 1000, ttlMs = 25 * 60 * 60 * 1000 } = {}) {
  const values = new Map();
  const lastAccess = new Map();

  const touch = (key, now) => { lastAccess.set(key, now); };

  const drop = (key) => {
    values.delete(key);
    lastAccess.delete(key);
  };

  // Lazy sweep: TTL first, then LRU trim to maxSize. Runs on every set so the
  // map stays bounded between accesses without a background timer.
  const evict = (now) => {
    for (const [key, at] of lastAccess) {
      if (now - at > ttlMs) drop(key);
    }
    if (values.size <= maxSize) return;
    // Oldest-first — Map preserves insertion order, so sort the surviving keys
    // by lastAccess and shed from the front until within the cap.
    const byAge = [...lastAccess.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of byAge) {
      if (values.size <= maxSize) break;
      drop(key);
    }
  };

  return {
    get(key) {
      if (!values.has(key)) return undefined;
      touch(key, Date.now());
      return values.get(key);
    },
    set(key, value) {
      const now = Date.now();
      values.set(key, value);
      touch(key, now);
      evict(now);
      return value;
    },
    has(key) {
      return values.has(key);
    },
    delete(key) {
      lastAccess.delete(key);
      return values.delete(key);
    },
    get size() {
      return values.size;
    },
    clear() {
      values.clear();
      lastAccess.clear();
    },
  };
}
