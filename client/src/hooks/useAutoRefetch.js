import { useState, useEffect, useRef, useCallback } from 'react';
import { useVisibilityEvent } from './useVisibilityEvent.js';

/**
 * Auto-refetch on an interval, pausing while the tab is hidden and re-firing
 * once when it becomes visible again. Replaces the per-component
 * useEffect + setInterval pattern for data-fetch polling.
 *
 * The hook catches whatever `fetchFn` throws, warns, and keeps the prior
 * `data` untouched — so data-path callers (those reading the returned `data`)
 * should NOT swallow errors with `.catch(() => null)`. Returning `null` here
 * applies that null and wipes the previously-displayed snapshot on every
 * transient blip; letting the error throw preserves the last good data.
 * `pollOnly` (side-effect) callers can also handle errors inside `fetchFn`
 * for their own logging or recovery; doing so swallows the rejection and
 * suppresses the hook's warn, so re-throw if you still want the hook log.
 *
 * `refetch` is intentionally unconditional — it bypasses the hidden-tab
 * short-circuit so explicit "Refresh" buttons work regardless of visibility.
 * Don't call it from effects that fire on mount/route change without a
 * visibility gate, or the "pauses while hidden" guarantee leaks.
 *
 * @param {Function} fetchFn - async; returns the new data, or any value if
 *   used purely for its side effects (see `pollOnly`).
 * @param {number} intervalMs - poll cadence; changing restarts the interval.
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - when false, no interval and no fetch.
 * @param {boolean} [options.immediate=true] - when false, skip the on-mount
 *   fetch and wait `intervalMs` before the first fetch. Use when the caller
 *   already performs a one-shot fetch via another path (e.g. `useCityData.fetchAll`).
 * @param {(prev:any, next:any)=>boolean} [options.compare] - when provided,
 *   each fetch keeps the previous reference (skipping the re-render) if
 *   `compare(prev, next)` returns true. Only invoked when both `prev` and
 *   `next` are non-null — the first fetch always sets data. Use for polls
 *   that return monotonic snapshots (e.g. `(a, b) => a.updatedAt === b.updatedAt`).
 *   Ignored in `pollOnly` mode (no data is tracked to compare).
 * @param {boolean} [options.pollOnly=false] - when true, the hook is treated
 *   as a side-effect-only poll tick: `data` / `loading` state is not tracked,
 *   no `applyResult` / setState calls run, and the return is `{ refetch }`
 *   only. Use when the caller owns its own state via `fetchFn`'s side
 *   effects and would otherwise `return null` and ignore `data` / `loading`.
 * @returns {{ refetch: Function, data?: any, loading?: boolean }}
 *   `data` and `loading` are omitted when `pollOnly` is true.
 */
export function useAutoRefetch(fetchFn, intervalMs, options = {}) {
  const { enabled = true, immediate = true, compare, pollOnly = false } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!pollOnly);
  const fetchRef = useRef(fetchFn);
  const compareRef = useRef(compare);

  useEffect(() => {
    fetchRef.current = fetchFn;
  }, [fetchFn]);

  // Kept in a ref so callers can pass an inline arrow without re-creating
  // applyResult/refetch on every render.
  useEffect(() => {
    compareRef.current = compare;
  }, [compare]);

  const applyResult = useCallback((result) => {
    if (pollOnly) return;
    setData((prev) => {
      const cmp = compareRef.current;
      if (cmp && prev != null && result != null && cmp(prev, result)) return prev;
      return result;
    });
  }, [pollOnly]);

  // Stable, unconditional refetch for callers (Refresh buttons, post-mutation
  // refresh paths, and key-change effects that need an immediate fetch with
  // the new closure). Bypasses the visibility short-circuit — when a user
  // clicks Refresh the tab is by definition visible.
  const refetch = useCallback(async () => {
    try {
      const result = await fetchRef.current();
      applyResult(result);
      if (!pollOnly) setLoading(false);
      return result;
    } catch (err) {
      console.warn(`⚠️ Auto-refetch failed: ${err?.message ?? String(err)}`);
      if (!pollOnly) setLoading(false);
      return undefined;
    }
  }, [applyResult, pollOnly]);

  const loadOnVisibleRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      loadOnVisibleRef.current = null;
      return undefined;
    }

    let cancelled = false;

    const loadData = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const result = await fetchRef.current();
        if (cancelled) return;
        applyResult(result);
        if (!pollOnly) setLoading(false);
      } catch (err) {
        console.warn(`⚠️ Auto-refetch failed: ${err?.message ?? String(err)}`);
        if (!cancelled && !pollOnly) setLoading(false);
      }
    };

    loadOnVisibleRef.current = loadData;
    if (immediate) loadData();
    const interval = setInterval(loadData, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
      loadOnVisibleRef.current = null;
    };
  }, [intervalMs, enabled, immediate, applyResult, pollOnly]);

  useVisibilityEvent((state) => {
    if (state === 'visible') loadOnVisibleRef.current?.();
  });

  if (pollOnly) return { refetch };
  return { data, loading, refetch };
}
