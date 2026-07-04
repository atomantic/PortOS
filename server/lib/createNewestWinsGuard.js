/**
 * createNewestWinsGuard — newest-render-wins ordering guard for out-of-order
 * async completions.
 *
 * The media-job completion hooks (writers-room / catalog / music-video scene-
 * image attach) all share a last-write-wins race: an OLDER render that completes
 * AFTER a newer regenerate would otherwise overwrite the newer frame. The GPU
 * lane is FIFO, but the Codex lane and renders kicked off from another client
 * (or after a refresh cleared the local spinner) can complete out of order — so
 * "last write wins by completion order" can show the new frame and then revert
 * to the stale one.
 *
 * This guard tracks, per slot `key`, the newest `queuedAt` whose render has been
 * applied. `isStale(key, at)` reports whether `at` is strictly older than that
 * recorded newest — i.e. this render should be dropped — and `mark(key, at)`
 * records a render as the newest after it applies. Callers read+write inside
 * their per-key serialize section so the check/record pair never races.
 *
 * Fixed-width UTC ISO timestamps (`new Date().toISOString()`) compare
 * chronologically as plain strings, so `at < prev` is a correct ordering test
 * without parsing. A null/absent `at` is never stale and never recorded (the job
 * carries no ordering info — fall through to last-write-wins for it).
 *
 * In-memory and best-effort: lost on restart, which is fine for the bookkeeping
 * it guards. Carries `.clear()` for test reset.
 *
 * The `latest` Map is NOT self-pruning (unlike `createKeyCachedQueue`'s tail
 * Map) — it retains one entry (`key → ~24-char ISO string`) per distinct slot
 * ever marked, for the process lifetime. The cardinality is the number of scene
 * slots rendered (per-scene / per-ingredient), which is human-scale for a
 * single-user install, so the growth is a non-issue in practice. If a future
 * caller needs bounded memory, add a `.forget(key)` and call it from the same
 * deletion path that drops the underlying record.
 */
export function createNewestWinsGuard() {
  const latest = new Map();

  return {
    // True when `at` is strictly older than the newest already applied for
    // `key` — the caller should drop this render. Absent `at` is never stale.
    isStale: (key, at) => {
      if (!at) return false;
      const prev = latest.get(key);
      return !!prev && at < prev;
    },
    // Record `at` as the newest applied for `key`. No-op for an absent `at` so
    // an untimed render can't poison the slot against future timed ones.
    mark: (key, at) => {
      if (at) latest.set(key, at);
    },
    clear: () => latest.clear(),
  };
}
