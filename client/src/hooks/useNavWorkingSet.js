import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
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

/**
 * Sidebar working-set state (Pinned + Recent), persisted to localStorage.
 * @param {(path: string) => ({ path, label, icon } | null)} resolveNavEntry
 *   Maps a stored route path to a display row, or null if it's not a known page.
 *   MUST be stable (useCallback or module-level) — an unstabilized inline function
 *   re-derives pinned/recent on every parent render.
 */
export function useNavWorkingSet(resolveNavEntry) {
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

  const resolveAll = useCallback(
    (paths) => paths.map((p) => resolveNavEntry(p)).filter(Boolean),
    [resolveNavEntry],
  );

  const pinned = useMemo(() => resolveAll(pinnedPaths), [resolveAll, pinnedPaths]);

  // Recent excludes the current page (already highlighted in nav) and any pinned pages.
  const recent = useMemo(() => {
    const pinnedSet = new Set(pinnedPaths);
    const visible = recentPaths.filter(
      (p) => p !== location.pathname && !pinnedSet.has(p),
    );
    return resolveAll(visible);
  }, [resolveAll, recentPaths, pinnedPaths, location.pathname]);

  return { pinned, recent, pin, unpin, isPinned };
}
