import { useCallback, useEffect, useRef } from 'react';

// A setTimeout-backed debounce whose pending callback can be cancelled
// synchronously by the caller — not only via the arming effect's own unmount
// cleanup. React's unmount runs asynchronously relative to a `navigate()`
// call made in the same tick (it waits for the router to re-render and
// commit), so a debounce timer armed well before that `navigate()` can still
// fire in the gap under load, landing a stale write after a route change is
// already in flight and clobbering it (#8187 — MediaCollections' query→URL
// mirror overwrote a just-opened collection's detail route). Storing the
// timer id in a ref that outlives a single render lets both the effect's own
// cleanup AND an imperative call site (e.g. right before `navigate()`) cancel
// the exact same pending write.
//
// `[schedule, cancel]`: `schedule(fn, delay)` replaces any pending call with
// a new one; `cancel()` drops a pending call with no replacement. Call
// `cancel()` immediately before any navigation that a stale debounced write
// must not be allowed to race.
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
