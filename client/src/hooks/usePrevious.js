import { useEffect, useRef } from 'react';

/**
 * Returns the value from the previous render. On the first render, returns
 * `initialValue` (default `undefined`).
 *
 * The snapshot is updated in a `useEffect`, so the returned value reflects
 * the *committed* prior value. Use this when the prior value is read from a
 * `useEffect` (post-commit) — e.g. fire a callback when a derived boolean
 * transitions from false to true.
 *
 * If you need the prior value to drive a synchronous `setState` during render
 * (React's "adjusting state on prop change" pattern), use `usePreviousSync`
 * — `usePrevious`'s effect-based snapshot would force one extra
 * discard-and-rerun cycle before the ref updates.
 */
export function usePrevious(value, initialValue) {
  const ref = useRef(initialValue);
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}

/**
 * Returns the value from the previous render and updates the snapshot
 * *during* render (not in an effect). On the first render, returns
 * `initialValue` (default `undefined`).
 *
 * Use this for React's "adjusting state on prop change" pattern, where the
 * prior value gates an in-render `setState` and you want React to discard
 * the in-progress render and re-run once with the new state — the
 * during-render ref update means the re-run sees the snapshot already
 * advanced, so the condition is false and the setState is skipped.
 *
 * Mutating a ref during render is supported by React (refs are escape
 * hatches and not tracked for re-renders); it is the idiomatic way to
 * snapshot the prior render's value synchronously.
 */
export function usePreviousSync(value, initialValue) {
  const ref = useRef(initialValue);
  const prev = ref.current;
  ref.current = value;
  return prev;
}
