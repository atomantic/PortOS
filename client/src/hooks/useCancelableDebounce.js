/**
 * `[schedule, cancel]` — `schedule(fn, delay)` arms a cancelable `setTimeout`, replacing any pending
 * call.
 *
 * `cancel()` drops it with no replacement. Call `cancel()` synchronously right before a navigation
 * that a stale debounced write must not be able to race (React's own unmount cleanup runs
 * asynchronously relative to `navigate()`, leaving a window under load). Use when: Any debounced
 * state→URL mirror sitting in front of a route that can change out from under it (Catalog,
 * MediaCollections search-query mirrors) — don't re-roll a bare `setTimeout`/`clearTimeout` pair.
 */

import { useCallback, useEffect, useRef } from 'react';

// A setTimeout-backed debounce whose pending callback the caller can cancel synchronously, not only via the arming effect's unmount cleanup: React's unmount runs asynchronously relative to a same-tick `navigate()`, so a timer armed earlier can fire in the gap under load
// and land a stale write after a route change is already in flight (#8187: MediaCollections' query→URL mirror overwrote a just-opened collection's detail route). Keeping the timer id in a ref lets both the effect cleanup AND an imperative call site cancel the same pending write.
// `[schedule, cancel]`: `schedule(fn, delay)` replaces any pending call; `cancel()` drops it with no replacement. Call `cancel()` right before any navigation that a stale debounced write must not race.
export default function useCancelableDebounce() {
  const timerRef = useRef(null);

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback((fn, delay) => {
    cancel();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fn();
    }, delay);
  }, [cancel]);

  // Unmount safety net for the normal (non-racing) case.
  useEffect(() => cancel, [cancel]);

  return [schedule, cancel];
}
