// Insights tab read with a distinct failure state: a failed read sets `error`
// (never `data`), so a tab renders "could not load + Retry" instead of the
// "not generated yet" empty state and the generate/compute/upload action it offers.
import { useState, useEffect, useCallback } from 'react';

export function useInsightRead(read) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    return read({ silent: true })
      .then(setData)
      .catch((err) => setError(err ?? new Error('Request failed')))
      .finally(() => setLoading(false));
  }, [read]);

  useEffect(() => { load(); }, [load]);

  return { data, setData, error, loading, reload: load };
}
