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

// The static head of a previous path: everything before its first `:param`
// segment. `/media/training/:datasetId` → `/media/training`, so a stored deep
// link into one record matches the subtree its page moved out of.
const staticBase = (previous) => {
  const segments = previous.split('/');
  const param = segments.findIndex((s) => s.startsWith(':'));
  return (param === -1 ? segments : segments.slice(0, param)).join('/').replace(/\/$/, '');
};

// Map a stored path onto the current path of the page that used to answer to it,
// preserving whatever followed (`/media/sprites/s-1` → `/sprites/s-1`).
//
// Driven by each nav command's own `previousPaths` — declared in
// `server/lib/navManifest.js` beside the page that moved and shipped whole in the
// palette manifest — so a move is ONE edit there rather than a second table here
// that can disagree. Returns the path unchanged when no page has moved off it.
//
// This is what keeps a pinned sidebar row alive across an app update: a pin is a
// stored route path, and before this a moved page's old path simply stopped
// matching the manifest, so the row silently rendered nothing.
export const migrateLegacyNavPath = (path, commands) => {
  if (!isPath(path)) return path;
  let best = null;
  for (const command of asList(commands)) {
    if (!isPath(command?.path)) continue;
    for (const previous of asList(command.previousPaths)) {
      const base = staticBase(previous);
      if (!base || !(path === base || path.startsWith(`${base}/`))) continue;
      // Longest base wins, so `/media/universe-builder` beats `/universe-builder`.
      if (!best || base.length > best.base.length) {
        best = {
          base,
          to: command.path,
          preserveSuffix: command.preservePreviousPathSuffix !== false,
        };
      }
    }
  }
  return best ? `${best.to}${best.preserveSuffix ? path.slice(best.base.length) : ''}` : path;
};

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

  for (const stored of asList(paths)) {
    // A page that has MOVED still sits in storage under its old path; resolve
    // that to where it lives now so the destination survives the update.
    const path = migrateLegacyNavPath(stored, commandList);
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
