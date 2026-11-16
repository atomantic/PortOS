/**
 * Deep-linkable `[activeTab, setActiveTab]` for a tabbed `<Drawer>`, backed by a caller-named URL
 * search param (falls back to a default on stale/missing).
 *
 * Use when: A tabbed config drawer whose open section should be shareable/bookmarkable — use with
 * `<Drawer tabs>`; don't re-roll the search-param plumbing.
 */

import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

// Deep-linkable active-tab state for a tabbed <Drawer>, backed by a URL search param so the open section is shareable, bookmarkable and reload-safe (the "URL is the source of truth for what's open" convention). Returns `[activeTab, setActiveTab]`.
// The caller owns the param name (a page may host more than one drawer, e.g. `?settingsTab=backend`) and passes the tab id list so a stale/hand-edited link degrades to `defaultTab` instead of a blank panel. Writing the default tab (or null) drops the param so a pristine URL stays clean; every write uses `replace` so flipping tabs doesn't pile history.
// A search param, not a route `:tab` segment (`useValidTab`), because a drawer overlays an already-routed page and can't own a path segment.
export default function useDrawerTab(paramName, defaultTab, tabIds = null) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(paramName);
  const valid = raw != null && (tabIds == null || tabIds.includes(raw));
  const activeTab = valid ? raw : defaultTab;

  const setActiveTab = useCallback((id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id == null || id === defaultTab) next.delete(paramName);
      else next.set(paramName, id);
      return next;
    }, { replace: true });
  }, [setSearchParams, paramName, defaultTab]);

  return [activeTab, setActiveTab];
}
