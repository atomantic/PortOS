import { useState, useEffect } from 'react';

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

  useEffect(() => {
    const loadData = async () => {
      const result = await fetchFn();
      setData(result);
      setLoading(false);
    };

    loadData();
    const interval = setInterval(loadData, intervalMs);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading };
}
