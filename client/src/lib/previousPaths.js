// Route-pattern helpers for NAV_COMMANDS[].previousPaths (server/lib/navManifest.js).
// App.jsx generates one redirect <Route> per previous path, and the sidebar maps a
// stored Pinned/Recent path onto where its page lives now. Both read the patterns
// the way React Router does — segment by segment, case-insensitive — so a stored
// path migrates exactly when the router would redirect it, and a paramless previous
// path (`/ai`) never captures a live sibling (`/ai/harnesses`).

const segmentsOf = (path) => String(path || '').split(/[?#]/)[0].split('/').filter(Boolean);
const isDynamic = (segment) => segment.startsWith(':') || segment === '*';

// Every previous path declared by a command, flattened into redirect records.
export const previousPathRedirects = (commands) => (Array.isArray(commands) ? commands : [])
  .flatMap((command) => (Array.isArray(command?.previousPaths) ? command.previousPaths : [])
    .map((from) => ({ from, to: command.path, preserveSuffix: command.preservePreviousPathSuffix !== false })));

// Number of leading static segments; the router ranks a longer static head higher.
export const previousPathStaticDepth = (from) => {
  const segments = segmentsOf(from);
  const dynamic = segments.findIndex(isDynamic);
  return dynamic === -1 ? segments.length : dynamic;
};

// Whether `pathname` is matched by the route pattern `from` (`:param` segments
// and a trailing `*` splat are supported).
export const matchesPreviousPath = (from, pathname) => {
  const pattern = segmentsOf(from);
  const parts = segmentsOf(pathname);
  let i = 0;
  for (const segment of pattern) {
    if (segment === '*') return true;
    if (i >= parts.length) return false;
    if (!segment.startsWith(':') && segment.toLowerCase() !== parts[i].toLowerCase()) return false;
    i += 1;
  }
  return i === parts.length;
};

// Where a request matched by `from` lands: the current path, plus everything after
// the previous path's static head when the record id is carried across, plus the
// caller's query and hash. A destination query (`/catalog?settings=1`) selects a
// feature view, so its keys win over a same-named incoming key.
export const previousPathTarget = ({ from, to, preserveSuffix = true }, { pathname = '', search = '', hash = '' } = {}) => {
  const [toPath, toQuery = ''] = String(to).split('?');
  const rest = preserveSuffix ? segmentsOf(pathname).slice(previousPathStaticDepth(from)) : [];
  const target = rest.length ? `${toPath.replace(/\/$/, '')}/${rest.join('/')}` : toPath;
  if (!toQuery) return `${target}${search}${hash}`;
  const params = new URLSearchParams(toQuery);
  const fixed = new Set(params.keys());
  for (const [key, value] of new URLSearchParams(search)) {
    if (!fixed.has(key)) params.append(key, value);
  }
  return `${target}?${params.toString()}${hash}`;
};
