/**
 * `[searchParams, updateParams]` — `updateParams(patch, { replace })` merges a patch into the query
 * string and deletes keys set to `null`/`undefined`/`''` so a cleared filter leaves the URL clean.
 *
 * Reads the live params off a ref (react-router's functional updater is closure-stale) and is referentially stable. Use for any page whose filter/sort/selection lives in the URL (Catalog, MediaCollections, Media3D).
 */

import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';

// URL-synced filter/selection state: `[searchParams, updateParams]`; `updateParams(patch, { replace })` merges a patch into the query string and DELETES keys whose value is `null` / `undefined` / `''`, so a cleared filter doesn't leave `?type=&tag=`.
// `replace` avoids history spam while typing (debounced mirrors); discrete clicks push so Back returns to the prior filter. Only those three values clear a key: `false` and `0` are written through (`"false"` / `"0"`) because a falsy-but-meaningful filter must survive a shared link.
// Multi-param sibling of `useDrawerTab`: the plumbing behind "the URL is the source of truth for what's filtered/selected".
export default function useUrlParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  // react-router's functional `setSearchParams` updater is NOT latest-state: it hands the callback `new URLSearchParams(searchParams)` captured in the render that memoized the setter, so a debounced write armed before a sort/toggle change would drop
  // the param the user just set. Read the live params and setter off refs instead; that also keeps `updateParams` referentially stable so effects depending on it don't re-arm on every unrelated query-param change.
  const paramsRef = useRef(searchParams);
  paramsRef.current = searchParams;
  const setParamsRef = useRef(setSearchParams);
  setParamsRef.current = setSearchParams;

  const updateParams = useCallback((patch, { replace = false } = {}) => {
    const next = new URLSearchParams(paramsRef.current);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    // Advance the ref before navigating so two patches in one tick compose (the router hasn't re-rendered, so `paramsRef.current` is still pre-patch); the next render reassigns it from the router, so an optimistic value never outlives its navigation.
    paramsRef.current = next;
    setParamsRef.current(next, { replace });
  }, []);

  return [searchParams, updateParams];
}
