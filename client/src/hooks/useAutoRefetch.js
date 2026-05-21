import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Auto-refetch on an interval, pausing while the tab is hidden and re-firing
 * once when it becomes visible again. Replaces the per-component
 * useEffect + setInterval pattern for data-fetch polling.
 *
 * fetchFn should handle its own errors and return either the new data or
 * `null` (the documented "no change / use prior" sentinel — returning
 * `undefined` would set data to undefined and lose prior state).
 * Side-effect-only callers that manage their own state should `return null`.
 *
 * @param {Function} fetchFn - async, returns the new data or null
 * @param {number} intervalMs - poll cadence; changing restarts the interval
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - when false, no interval and no fetch
 * @returns {{ data: any, loading: boolean, refetch: Function }}
 */
export function useAutoRefetch(fetchFn, intervalMs, options = {}) {
  const { enabled = true } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetchFn);

  useEffect(() => {
    fetchRef.current = fetchFn;
  }, [fetchFn]);

  // Stable, unconditional refetch for callers (Refresh buttons, post-mutation
  // refresh paths). Bypasses the visibility short-circuit — when a user
  // clicks Refresh the tab is by definition visible.
  const refetch = useCallback(async () => {
    try {
      const result = await fetchRef.current();
      setData(result);
      setLoading(false);
      return result;
    } catch (err) {
      console.warn(`⚠️ Auto-refetch failed: ${err.message}`);
      setLoading(false);
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    const loadData = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const result = await fetchRef.current();
        if (cancelled) return;
        setData(result);
        setLoading(false);
      } catch (err) {
        console.warn(`⚠️ Auto-refetch failed: ${err.message}`);
        if (!cancelled) setLoading(false);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadData();
    };

    loadData();
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
  }, [intervalMs, enabled]);

  return { data, loading, refetch };
}
