/**
 * Returns the value from the previous render — snapshot updated in a `useEffect`.
 *
 * `usePreviousSync` has the same shape but updates its snapshot *during* render, for compare-and-act on prop/state change (the prior value gates an in-render `setState`, avoiding an extra discard/rerun cycle).
 */

import { useEffect, useRef } from 'react';

/**
 * Returns the value from the previous render (`initialValue` on the first, default `undefined`). The snapshot updates in a `useEffect`, so this is the *committed* prior value, for reading from a `useEffect` (e.g. fire when a boolean goes false → true).
 * To drive a synchronous `setState` during render ("adjusting state on prop change"), use `usePreviousSync`: the effect-based snapshot would force an extra discard-and-rerun.
 */
export function usePrevious(value, initialValue) {
  const ref = useRef(initialValue);
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}

/**
 * Returns the value from the previous render and updates the snapshot *during* render. For "adjusting state on prop change", where the prior value gates an in-render `setState`: the during-render ref update means the
 * re-run sees the snapshot already advanced, so the condition is false and the setState is skipped. Mutating a ref during render is supported by React for this.
 */
export function usePreviousSync(value, initialValue) {
  const ref = useRef(initialValue);
  const prev = ref.current;
  ref.current = value;
  return prev;
}
