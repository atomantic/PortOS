import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

// URL-synced filter/selection state: `[searchParams, updateParams]`, where
// `updateParams(patch, { replace })` merges a patch into the current query
// string and DELETES any key whose value is `null` / `undefined` / `''`, so a
// cleared filter leaves the URL clean instead of trailing `?type=&tag=`.
// `replace` avoids history spam while typing (debounced mirrors); discrete
// clicks push so Back returns to the prior filter.
//
// Only those three values clear a key — `false` and `0` are written through as
// `"false"` / `"0"`, because a falsy-but-meaningful value is a legitimate
// filter state and must not vanish from a shared link.
//
// The sibling of `useDrawerTab` (single named param, tab-shaped) for the
// multi-param case: this is the plumbing behind "the URL is the source of truth
// for what's filtered/selected".
export default function useUrlParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  // react-router's functional `setSearchParams` updater is NOT latest-state: it
  // hands the callback `new URLSearchParams(searchParams)` captured in the
  // closure of the render that memoized the setter. A debounced write armed
  // before a sort/toggle change would therefore navigate with the pre-change
  // snapshot and silently drop the param the user just set. Read the live
  // params — and the live setter — off refs instead. That also keeps
  // `updateParams` referentially stable, so effects that list it as a
  // dependency don't re-arm every time any unrelated query param changes.
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
    setParamsRef.current(next, { replace });
  }, []);

  return [searchParams, updateParams];
}
