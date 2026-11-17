/**
 * Newest-render-wins ordering guard for out-of-order async completions.
 *
 * `createNewestWinsGuard()` returns `{ isStale(key, at), mark(key, at), clear() }` — tracks the newest
 * applied `queuedAt` per slot `key` so an older render completing after a newer one is dropped
 * (`isStale` true) instead of clobbering the newer frame. ISO timestamps compare as strings; absent
 * `at` is never stale. Used by `createMediaJobImageHook`'s opt-in guard and the catalog hook's
 * portrait slot.
 */

/**
 * Callers read+write inside their per-key serialize section so the check/record
 * pair never races. Fixed-width UTC ISO timestamps compare chronologically as
 * strings. The `latest` Map is NOT self-pruning: one entry per slot ever marked
 * (human-scale); add a `.forget(key)` if bounded memory is ever needed.
 */
export function createNewestWinsGuard() {
  const latest = new Map();

  return {
    isStale: (key, at) => {
      if (!at) return false;
      const prev = latest.get(key);
      return !!prev && at < prev;
    },
    // No-op for an absent `at` (can't poison the slot) and never rewinds.
    mark: (key, at) => {
      if (at && !(latest.get(key) > at)) latest.set(key, at);
    },
    clear: () => latest.clear(),
  };
}
