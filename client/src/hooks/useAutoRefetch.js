import { useState, useEffect, useRef } from 'react';

/**
 * Hook for auto-refetching data on an interval.
 * Eliminates the repeated useEffect + setInterval pattern across dashboard widgets.
 *
 * @param {Function} fetchFn - Async function that returns data (should handle its own errors)
 * @param {number} intervalMs - Refetch interval in milliseconds
 * @returns {{ data: any, loading: boolean }}
 */
export function useAutoRefetch(fetchFn, intervalMs) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetchFn);

  // Keep ref current so interval callbacks don't capture stale closures
  useEffect(() => {
    fetchRef.current = fetchFn;
  }, [fetchFn]);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      try {
        const result = await fetchRef.current();
        if (cancelled) return;
        setData(result);
        setLoading(false);
      } catch {
        // Keep prior data on failure, just clear loading state
        if (!cancelled) setLoading(false);
      }
    };

    loadData();
    const interval = setInterval(loadData, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [intervalMs]);

  return { data, loading };
}
