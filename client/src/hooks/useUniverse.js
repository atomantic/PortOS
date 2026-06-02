import { useEffect, useState } from 'react';
import { getUniverse } from '../services/apiUniverseBuilder.js';
import useMounted from './useMounted.js';

// Load the universe record for a given id (typically `series.universeId`).
// Collapses the `useMounted` + `let cancelled` + `getUniverse(id).then/.catch`
// effect that pipeline stages were each hand-rolling. Returns a tuple shaped
// like `useState` plus load metadata:
//   [universe, setUniverse, loading, error]
//   - universe: the record, or null when unloaded / not-found / failed.
//   - setUniverse: the underlying state setter, so callers can apply optimistic
//     updates after a mutation (canon patch, refine, extract) without a refetch.
//     A change to `universeId` re-fetches and overwrites, but same-id optimistic
//     writes are preserved (the effect only re-runs when the id changes).
//   - loading: true while a fetch is in flight.
//   - error: the rejection reason, or null. Errors still toast via the shared
//     request helper (behavior unchanged); this just exposes the reason too.
// A falsy `universeId` clears state to [null, …, false, null] without fetching.
export default function useUniverse(universeId) {
  const mountedRef = useMounted();
  const [universe, setUniverse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!universeId) {
      setUniverse(null);
      setLoading(false);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUniverse(universeId).then((w) => {
      if (cancelled || !mountedRef.current) return;
      setUniverse(w || null);
      setLoading(false);
    }).catch((err) => {
      if (cancelled || !mountedRef.current) return;
      setUniverse(null);
      setError(err);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [universeId, mountedRef]);

  return [universe, setUniverse, loading, error];
}
