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
    const loadData = async () => {
      const result = await fetchRef.current();
      setData(result);
      setLoading(false);
    };

    loadData();
    const interval = setInterval(loadData, intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);

  return { data, loading };
}
