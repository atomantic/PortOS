/**
 * Sidebar Pinned + Recent working set (localStorage MRU + pins).
 *
 * Resolves stored paths to `{ path, label, icon }` rows via a `resolveNavEntry` arg. Use when:
 * Rendering the sidebar's Pinned/Recent sections.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import {
  RECENT_KEY, PINNED_KEY,
  recordVisit, togglePin as togglePinPure, isPinned as isPinnedPure,
} from '../utils/navWorkingSet.js';
import { safeReadJsonStorage, safeWriteStorage } from '../lib/safeStorage.js';

// Read a JSON string[] from localStorage, tolerating absent/corrupt/throwing storage.
const readList = (key) => {
  const parsed = safeReadJsonStorage(key, []);
  return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
};

// Persist a JSON string[]; ignore storage failures (private mode / quota) so the
// in-memory React state still updates and the app never crashes on a write.
const writeList = (key, list) => safeWriteStorage(key, JSON.stringify(list));

// Replace each stored path with the CURRENT path it resolves to, so a page that
// has MOVED is stored under where it lives now — pin state and unpin() then
// compare against the same path the sidebar rendered. Returns the original list
// when nothing moved, so the effect below settles after one pass.
//
// Only paths that actually resolve are rewritten. A path resolving to nothing is
// left exactly as stored: during boot the dynamic app/series/universe rows have
// not loaded yet, and dropping or rewriting a pin on that transient miss would
// lose it for good.
const normalizeToCurrentPaths = (paths, resolveNavEntry) => {
  let changed = false;
  const next = [];
  for (const stored of paths) {
    const current = resolveNavEntry(stored)?.path || stored;
    if (current !== stored) changed = true;
    if (next.includes(current)) changed = true;
    else next.push(current);
  }
  return changed ? next : paths;
};

/** Raw paths are available before the dynamic navigation lists resolve. */
export function useNavWorkingSet() {
  const location = useLocation();

  // Record the initial visit synchronously so it's present on first render.
  // The useEffect below handles subsequent navigations only.
  const [recentPaths, setRecentPaths] = useState(() => {
    const initial = recordVisit(location.pathname, readList(RECENT_KEY));
    writeList(RECENT_KEY, initial);
    return initial;
  });
  const [pinnedPaths, setPinnedPaths] = useState(() => readList(PINNED_KEY));

  // Track the last recorded path to skip the initial effect (already handled above).
  const lastRecordedRef = useRef(location.pathname);

  // Record visits when the route changes after the initial render.
  useEffect(() => {
    if (lastRecordedRef.current === location.pathname) return;
    lastRecordedRef.current = location.pathname;
    setRecentPaths((prev) => {
      const next = recordVisit(location.pathname, prev);
      writeList(RECENT_KEY, next);
      return next;
    });
  }, [location.pathname]);

  const pin = useCallback((path) => {
    setPinnedPaths((prev) => {
      if (isPinnedPure(path, prev)) return prev;
      const next = togglePinPure(path, prev);
      writeList(PINNED_KEY, next);
      return next;
    });
  }, []);

  const unpin = useCallback((path) => {
    setPinnedPaths((prev) => {
      if (!isPinnedPure(path, prev)) return prev;
      const next = togglePinPure(path, prev);
      writeList(PINNED_KEY, next);
      return next;
    });
  }, []);

  const isPinned = useCallback((path) => isPinnedPure(path, pinnedPaths), [pinnedPaths]);

  return { pinnedPaths, recentPaths, setPinnedPaths, setRecentPaths, pin, unpin, isPinned };
}

export function useResolvedNavWorkingSet({ pinnedPaths, recentPaths, setPinnedPaths, setRecentPaths }, resolveNavEntry, pathname) {
  // Fold moved pages back into storage once the nav manifest can resolve them.
  // Settles after one pass: normalizeToCurrentPaths returns the SAME list when
  // nothing moved, so the state updates (and the effect's own deps) stop there.
  useEffect(() => {
    const nextPinned = normalizeToCurrentPaths(pinnedPaths, resolveNavEntry);
    if (nextPinned !== pinnedPaths) {
      setPinnedPaths(nextPinned);
      writeList(PINNED_KEY, nextPinned);
    }
    const nextRecent = normalizeToCurrentPaths(recentPaths, resolveNavEntry);
    if (nextRecent !== recentPaths) {
      setRecentPaths(nextRecent);
      writeList(RECENT_KEY, nextRecent);
    }
  }, [resolveNavEntry, pinnedPaths, recentPaths, setPinnedPaths, setRecentPaths]);

  const resolveAll = useCallback(
    (paths) => paths.map((p) => resolveNavEntry(p)).filter(Boolean),
    [resolveNavEntry],
  );

  const pinned = useMemo(() => resolveAll(pinnedPaths), [resolveAll, pinnedPaths]);

  // Recent excludes the current page (already highlighted in nav) and any pinned pages.
  const recent = useMemo(() => {
    const pinnedSet = new Set(pinnedPaths);
    const visible = recentPaths.filter(
      (p) => p !== pathname && !pinnedSet.has(p),
    );
    return resolveAll(visible);
  }, [resolveAll, recentPaths, pinnedPaths, pathname]);

  return { pinned, recent };
}
