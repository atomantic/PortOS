import { useState, useEffect, useRef, useCallback } from 'react';
import { useVisibilityEvent } from './useVisibilityEvent.js';

/**
 * Auto-refetch on an interval, pausing while the tab is hidden and re-firing
 * once when it becomes visible again. Replaces the per-component
 * useEffect + setInterval pattern for data-fetch polling.
 *
 * fetchFn should handle its own errors. Side-effect-only callers that manage
 * their own state via setStates inside fetchFn should pass `{ pollOnly: true }`
 * so the hook skips its own data/loading bookkeeping and returns only
 * `{ refetch }`.
 *
 * Data-path callers (those reading the returned `data`) should NOT swallow
 * errors with `.catch(() => null)` — the hook will then apply that null and
 * wipe the previously-displayed snapshot on every transient blip. Let the
 * error throw; the hook's catch logs it and preserves the last good data.
 *
 * `refetch` is intentionally unconditional — it bypasses the hidden-tab
 * short-circuit so explicit "Refresh" buttons work regardless of visibility.
 * Don't call it from effects that fire on mount/route change without a
 * visibility gate, or the "pauses while hidden" guarantee leaks.
 *
 * @param {Function} fetchFn - async, returns the new data
 * @param {number} intervalMs - poll cadence; changing restarts the interval
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - when false, no interval and no fetch
 * @param {boolean} [options.immediate=true] - when false, skip the on-mount fetch
 *   and wait `intervalMs` before the first fetch. Use when the caller already
 *   performs a one-shot fetch via another path (e.g. `useCityData.fetchAll`).
 * @param {boolean} [options.pollOnly=false] - when true, the hook drives the
 *   fetchFn on schedule but tracks no data/loading itself and returns
 *   `{ refetch }` only. Use for callers whose fetchFn already updates external
 *   state via setStates inside its body — they don't read `data` and shouldn't
 *   trigger an extra render per tick. `compare` is ignored in this mode.
 * @param {(prev:any, next:any)=>boolean} [options.compare] - when provided,
 *   each fetch keeps the previous reference (skipping the re-render) if
 *   `compare(prev, next)` returns true. Only invoked when both `prev` and
 *   `next` are non-null — the first fetch always sets data. Use for polls
 *   that return monotonic snapshots (e.g. `(a, b) => a.updatedAt === b.updatedAt`).
 * @returns {{ refetch: Function } | { data: any, loading: boolean, refetch: Function }}
 *   — `pollOnly: true` returns `{ refetch }` only.
 */
export function useAutoRefetch(fetchFn, intervalMs, options = {}) {
  const { enabled = true, immediate = true, compare, pollOnly = false } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!pollOnly);
  const fetchRef = useRef(fetchFn);
  const compareRef = useRef(compare);

  useEffect(() => {
    fetchRef.current = fetchFn;
  }, [fetchFn]);

  // Kept in a ref so callers can pass an inline arrow without re-creating
  // applyResult/refetch on every render. `pollOnly` is a hook-mode selector
  // expected to be a boolean literal, so closing over it directly is fine.
  useEffect(() => {
    compareRef.current = compare;
  }, [compare]);

  const applyResult = useCallback((result) => {
    if (pollOnly) return;
    setData((prev) => {
      const cmp = compareRef.current;
      if (cmp && prev != null && result != null && cmp(prev, result)) return prev;
      return result;
    });
  }, [pollOnly]);

  const clearLoading = useCallback(() => {
    if (!pollOnly) setLoading(false);
  }, [pollOnly]);

  // Stable, unconditional refetch for callers (Refresh buttons, post-mutation
  // refresh paths, and key-change effects that need an immediate fetch with
  // the new closure). Bypasses the visibility short-circuit — when a user
  // clicks Refresh the tab is by definition visible.
  const refetch = useCallback(async () => {
    try {
      const result = await fetchRef.current();
      applyResult(result);
      clearLoading();
      return result;
    } catch (err) {
      console.warn(`⚠️ Auto-refetch failed: ${err.message}`);
      clearLoading();
      return undefined;
    }
  }, [applyResult, clearLoading]);

  const loadOnVisibleRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      loadOnVisibleRef.current = null;
      return undefined;
    }

    let cancelled = false;

    const loadData = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const result = await fetchRef.current();
        if (cancelled) return;
        applyResult(result);
        clearLoading();
      } catch (err) {
        console.warn(`⚠️ Auto-refetch failed: ${err.message}`);
        if (!cancelled) clearLoading();
      }
    };

    loadOnVisibleRef.current = loadData;
    if (immediate) loadData();
    const interval = setInterval(loadData, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
      loadOnVisibleRef.current = null;
    };
  }, [intervalMs, enabled, immediate, applyResult, clearLoading]);

  useVisibilityEvent((state) => {
    if (state === 'visible') loadOnVisibleRef.current?.();
  });

  if (pollOnly) return { refetch };
  return { data, loading, refetch };
}
