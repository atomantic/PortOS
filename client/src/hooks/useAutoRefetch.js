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
 * Each hook instance is single-flight: at most one `fetchFn` call is pending
 * at a time, so a slow response can never land after (and overwrite) a newer
 * one, and a stalled request can't pile up a new request per tick. Interval
 * and visibility ticks that arrive while a fetch is pending are dropped. A
 * `refetch()` that arrives while a fetch is pending queues ONE trailing fetch
 * (the pending one may predate the caller's mutation); every `refetch()` made
 * during that window shares the trailing fetch's promise. Unmounting drops a
 * queued trailing fetch — its promise resolves `undefined` without fetching.
 *
 * @param {Function} fetchFn - async; returns the new data, or any value if
 *   used purely for its side effects (see `pollOnly`).
 * @param {number} intervalMs - poll cadence; changing restarts the interval.
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - when false, no interval and no fetch.
 * @param {boolean} [options.immediate=true] - when false, skip the on-mount
 *   fetch and wait `intervalMs` before the first fetch. Use when the caller
 *   already performs a one-shot fetch via another path.
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
 * @returns {{ refetch: Function, data?: any, loading?: boolean, error?: Error|null }}
 *   `data` / `loading` / `error` are omitted when `pollOnly` is true. `error`
 *   holds the most recent fetch failure (cleared on the next success) — the
 *   `data` it accompanies is still the last GOOD result, per the note above,
 *   so a caller that wants to show a "showing stale data" indicator without
 *   erasing the last good render checks `error` alongside `data` rather than
 *   inferring staleness from an empty/falsy `data`.
 */
// Normalize whatever a rejected fetchFn threw (an Error, or any other value —
// a caller can reject with a plain string/object) into a real Error so
// `error.message` is always safe to read.
const toFetchError = (err) => (err instanceof Error ? err : new Error(String(err ?? 'Auto-refetch failed')));

export function useAutoRefetch(fetchFn, intervalMs, options = {}) {
  const { enabled = true, immediate = true, compare, pollOnly = false } = options;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!pollOnly);
  const [error, setError] = useState(null);
  const fetchRef = useRef(fetchFn);
  const compareRef = useRef(compare);
  // The pending fetch (`{ promise, owner }`) or null. `owner` is the poll
  // effect's cancellation token for a tick-started fetch, or null for a manual
  // one — see `startFetch`.
  const inFlightRef = useRef(null);
  // A `refetch()` that arrived mid-flight: `{ promise, resolve }`, or null.
  const trailingRef = useRef(null);
  const disposedRef = useRef(false);

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
    setError(null);
    setData((prev) => {
      const cmp = compareRef.current;
      if (cmp && prev != null && result != null && cmp(prev, result)) return prev;
      return result;
    });
  }, [pollOnly]);

  // Runs one fetch as the instance's single in-flight request. A tick-started
  // fetch carries its poll effect's token as `owner`, so a result landing after
  // that effect was torn down (unmount, or `enabled` flipped off) is dropped —
  // unless a newer poll effect adopted it (see `loadData`). A manual fetch has
  // no owner and applies unless the hook unmounted. When it settles, a queued
  // trailing refetch starts, or is abandoned if the hook unmounted meanwhile.
  const startFetch = useCallback(function runFetch(owner) {
    const run = { owner, promise: null };
    const shouldApply = () => !disposedRef.current && !run.owner?.cancelled;
    // Claimed before the call: a fetchFn that throws synchronously settles
    // (and runs `finally`) before the IIFE returns.
    inFlightRef.current = run;
    run.promise = (async () => {
      try {
        const result = await fetchRef.current();
        if (shouldApply()) {
          applyResult(result);
          if (!pollOnly) setLoading(false);
        }
        return result;
      } catch (err) {
        console.warn(`⚠️ Auto-refetch failed: ${err?.message ?? String(err)}`);
        if (shouldApply() && !pollOnly) {
          setLoading(false);
          setError(toFetchError(err));
        }
        return undefined;
      } finally {
        inFlightRef.current = null;
        const trailing = trailingRef.current;
        trailingRef.current = null;
        if (trailing) trailing.resolve(disposedRef.current ? undefined : runFetch(null).promise);
      }
    })();
    return run;
  }, [applyResult, pollOnly]);

  // Stable, unconditional refetch for callers (Refresh buttons, post-mutation
  // refresh paths, and key-change effects that need an immediate fetch with
  // the new closure). Bypasses the visibility short-circuit — when a user
  // clicks Refresh the tab is by definition visible.
  const refetch = useCallback(() => {
    if (!inFlightRef.current) return startFetch(null).promise;
    if (!trailingRef.current) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      trailingRef.current = { promise, resolve };
    }
    return trailingRef.current.promise;
  }, [startFetch]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      // Drop a queued follow-up now rather than when the pending fetch
      // settles, so nothing fires after unmount.
      trailingRef.current?.resolve(undefined);
      trailingRef.current = null;
    };
  }, []);

  const loadOnVisibleRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      loadOnVisibleRef.current = null;
      return undefined;
    }

    const token = { cancelled: false };

    const loadData = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const pending = inFlightRef.current;
      if (pending) {
        // Coalesce: never stack a second request. A tick-started fetch owned
        // by a torn-down poll effect (StrictMode remount, interval change,
        // enabled re-toggle) is adopted so its result still lands.
        if (pending.owner) pending.owner = token;
        return;
      }
      startFetch(token);
    };

    loadOnVisibleRef.current = loadData;
    if (immediate) loadData();
    const interval = setInterval(loadData, intervalMs);

    return () => {
      token.cancelled = true;
      clearInterval(interval);
      loadOnVisibleRef.current = null;
    };
  }, [intervalMs, enabled, immediate, startFetch]);

  useVisibilityEvent((state) => {
    if (state === 'visible') loadOnVisibleRef.current?.();
  });

  if (pollOnly) return { refetch };
  return { data, loading, error, refetch };
}
