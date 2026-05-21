import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Auto-refetch on an interval, pausing while the tab is hidden and re-firing
 * once when it becomes visible again. Replaces the per-component
 * useEffect + setInterval pattern for data-fetch polling.
 *
 * fetchFn should handle its own errors. Side-effect-only callers that manage
 * their own state via setStates inside fetchFn typically `return null` and
 * ignore the hook's `data` return; that's fine, but be aware the hook will
 * still set `data = null` on each tick.
 *
 * @param {Function} fetchFn - async, returns the new data
 * @param {number} intervalMs - poll cadence; changing restarts the interval
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - when false, no interval and no fetch
 * @param {boolean} [options.immediate=true] - when false, skip the on-mount fetch
 *   and wait `intervalMs` before the first fetch. Use when the caller already
 *   performs a one-shot fetch via another path (e.g. `useCityData.fetchAll`).
 * @param {(prev:any, next:any)=>boolean} [options.compare] - when provided,
 *   each fetch keeps the previous reference (skipping the re-render) if
 *   `compare(prev, next)` returns true. Only invoked when both `prev` and
 *   `next` are non-null — the first fetch always sets data. Use for polls
 *   that return monotonic snapshots (e.g. `(a, b) => a.updatedAt === b.updatedAt`).
 * @returns {{ data: any, loading: boolean, refetch: Function }}
 */
export function useAutoRefetch(fetchFn, intervalMs, options = {}) {
  const { enabled = true, immediate = true, compare } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetchFn);
  const compareRef = useRef(compare);

  useEffect(() => {
    fetchRef.current = fetchFn;
  }, [fetchFn]);

  // Kept in a ref so callers can pass an inline arrow without re-creating
  // applyResult/refetch on every render.
  useEffect(() => {
    compareRef.current = compare;
  }, [compare]);

  const applyResult = useCallback((result) => {
    setData((prev) => {
      const cmp = compareRef.current;
      if (cmp && prev != null && result != null && cmp(prev, result)) return prev;
      return result;
    });
  }, []);

  // Stable, unconditional refetch for callers (Refresh buttons, post-mutation
  // refresh paths, and key-change effects that need an immediate fetch with
  // the new closure). Bypasses the visibility short-circuit — when a user
  // clicks Refresh the tab is by definition visible.
  const refetch = useCallback(async () => {
    try {
      const result = await fetchRef.current();
      applyResult(result);
      setLoading(false);
      return result;
    } catch (err) {
      console.warn(`⚠️ Auto-refetch failed: ${err.message}`);
      setLoading(false);
      return undefined;
    }
  }, [applyResult]);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    const loadData = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const result = await fetchRef.current();
        if (cancelled) return;
        applyResult(result);
        setLoading(false);
      } catch (err) {
        console.warn(`⚠️ Auto-refetch failed: ${err.message}`);
        if (!cancelled) setLoading(false);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadData();
    };

    if (immediate) loadData();
    const interval = setInterval(loadData, intervalMs);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [intervalMs, enabled, immediate, applyResult]);

  return { data, loading, refetch };
}
