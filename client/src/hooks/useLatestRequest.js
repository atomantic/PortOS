import { useCallback, useEffect, useRef } from 'react';

// Latest-request-wins guard for a load keyed on changing input (a search box, a
// route param like the active privacy subject). `begin()` supersedes every
// earlier request and returns an `isCurrent()` predicate; an older response
// that resolves after a newer request started (or after unmount) reads
// `isCurrent() === false` and must drop its setState, so it can't overwrite the
// view the user has already moved on to.
//
// Counter-based, so React StrictMode's mount→cleanup→remount cycle needs no
// re-arm: the remount's effect simply calls `begin()` again.
export default function useLatestRequest() {
  const generationRef = useRef(0);
  useEffect(() => () => { generationRef.current += 1; }, []);
  return useCallback(() => {
    const generation = ++generationRef.current;
    return () => generation === generationRef.current;
  }, []);
}
