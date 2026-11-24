/**
 * Drops a repeat of an async action while the same one is still running, so a double click creates one record.
 *
 * Use when: a button or form creates something, or starts paid work, and nothing disables it while the request runs.
 *
 * Usage:
 *   const handleCreate = useSingleFlight(async () => { … });
 *   const handleRender = useSingleFlight(async (kind, entry) => { … }, (kind, entry) => entry.id);
 *
 * `keyOf` lets rows run side by side while one row still runs once. Use `useAsyncAction` instead when the button
 * needs its own running state.
 */

import { useRef } from 'react';

export function useSingleFlight(fn, keyOf = () => '') {
  const running = useRef(new Set());
  return async (...args) => {
    // A dropped submit must still not navigate the page.
    args[0]?.preventDefault?.();
    const key = keyOf(...args);
    if (running.current.has(key)) return undefined;
    running.current.add(key);
    try {
      return await fn(...args);
    } finally {
      running.current.delete(key);
    }
  };
}

export default useSingleFlight;
