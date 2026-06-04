// Pure working-set helpers for the sidebar Pinned + Recent sections.
// No DOM / localStorage access here — callers (useNavWorkingSet) own I/O so
// this logic is testable in node. Lists are plain string[] of route paths,
// most-recent-first for Recent and insertion-order for Pinned.

export const RECENT_KEY = 'portos-nav-recent';
export const PINNED_KEY = 'portos-nav-pinned';
export const RECENT_CAP = 5;

const asList = (list) => (Array.isArray(list) ? list : []);
const isPath = (p) => typeof p === 'string' && p.length > 0;

// Move/insert `path` to the front of the MRU list, dedup, cap at RECENT_CAP.
export const recordVisit = (path, list) => {
  const current = asList(list);
  if (!isPath(path)) return current;
  return [path, ...current.filter((p) => p !== path)].slice(0, RECENT_CAP);
};

// Add `path` if absent, remove it if present.
export const togglePin = (path, list) => {
  const current = asList(list);
  if (!isPath(path)) return current;
  return current.includes(path)
    ? current.filter((p) => p !== path)
    : [...current, path];
};

export const isPinned = (path, list) => asList(list).includes(path);
