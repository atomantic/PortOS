// Pure working-set helpers for the sidebar Pinned + Recent sections.
// No DOM / localStorage access here — callers (useNavWorkingSet) own I/O so
// this logic is testable in node. Lists are plain string[] of route paths,
// most-recent-first for Recent and insertion-order for Pinned.

export const RECENT_KEY = 'portos-nav-recent';
export const PINNED_KEY = 'portos-nav-pinned';
export const RECENT_CAP = 5;

const asList = (list) => (Array.isArray(list) ? list : []);
const isPath = (p) => typeof p === 'string' && /^\/(?!\/)/.test(p);

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

// Resolve stored recent paths against the server-backed nav manifest. Exact
// routes win; deep-link selections fall back to the longest matching base route
// while preserving the stored destination path for navigation.
export const resolveRecentNavEntries = (paths, commands, {
  currentPath = null,
  limit = RECENT_CAP,
} = {}) => {
  const commandList = asList(commands).filter((command) => isPath(command?.path));
  const seenPaths = new Set();
  const resolved = [];

  for (const path of asList(paths)) {
    if (!isPath(path) || path === currentPath || seenPaths.has(path)) continue;
    seenPaths.add(path);

    let match = null;
    for (const command of commandList) {
      const exact = command.path === path;
      const containsDeepLink = command.path !== '/' && path.startsWith(`${command.path}/`);
      if ((exact || containsDeepLink) && (!match || command.path.length > match.path.length)) {
        match = command;
      }
    }

    if (match) resolved.push({ ...match, path });
    if (resolved.length >= limit) break;
  }

  return resolved;
};
