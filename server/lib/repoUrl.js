/**
  * Git repository URL parsing, AUTHORITATIVE copy: `parseRepoUrl(url)` → `{ host, provider, owner, repo }`, `isRepoUrl`, `repoCloneUrl`, `repoBrowseUrl`, `parseGitHubUrl`, `isGitHubRepoUrl`.
  *
  * The rule for "is this a clonable repo URL?" (github.com and gitlab.com), with per-host behavior (subgroup nesting, clone layout) in the `REPO_HOSTS` table. Lives in `lib/` (not `services/repoCloner.js`, which re-exports it) and is re-exported by `client/src/lib/repoUrl.js` so the Brain capture boxes preview the same answer BEFORE submitting and offer post-clone agent options for exactly the URLs the server will clone. A pure leaf: import no Node built-in and nothing outside `server/lib`.
 */

// The host allowlist and the two behaviors that differ between hosts live IN the table, not as `host === 'github.com'` branches, so a new host is one entry and each flag is decided deliberately.
//   provider           stable id stored on a link record (`repoHost` holds the hostname itself)
//   namespace.maxDepth path segments allowed before the project. 1 = no subgroups (GitHub: anything past owner/repo is a deep link). GitLab nests subgroups but is CAPPED: a bare
//                      GitLab URL has no marker separating `group/sub/project` from `group/project/route/...`, so an unbounded walk reads a project asset URL as a deep namespace and
//                      manufactures directories INSIDE an existing clone. The cap also bounds the on-disk layout `repoCloner`'s staging sweep derives its recursion depth from.
//   namespace.allowDots whether a namespace segment may contain a dot (GitHub logins may not; GitLab groups may). Off for the flat-clone host it also makes a hostname collision
//                      impossible (`github.com/gitlab.com/x` cannot parse).
//   flatClonePath      LEGACY CARVE-OUT: clone to `<owner>/<repo>` with no hostname level so clones predating the second host stay where their link record says. Never set for a new host.
export const REPO_HOSTS = Object.freeze({
  'github.com': { provider: 'github', namespace: { maxDepth: 1, allowDots: false }, flatClonePath: true },
  'gitlab.com': { provider: 'gitlab', namespace: { maxDepth: 3, allowDots: true }, flatClonePath: false },
});

/** The deepest `<host>/<namespace…>/<repo>` layout any host in the table produces. */
export const MAX_REPO_PATH_DEPTH = Object.values(REPO_HOSTS).reduce(
  (deepest, { namespace, flatClonePath }) => Math.max(deepest, (flatClonePath ? 0 : 1) + namespace.maxDepth + 1),
  0,
);

// owner/repo is a PATH OPERAND (the cloner clones into `join(reposDir, …owner, repo)` and `localPath` is handed to an agent to scan), so each segment is matched against the character sets hosts actually
// allow, not "anything but a slash" (the loose form parsed `https://github.com/../evil` as owner `..`, outside the clone root).
//   owner: a login or GitLab group/subgroup; both forms REQUIRE a leading alphanumeric, making `.`/`..` unrepresentable; the dotted form is gated per host (`namespace.allowDots`).
//   repo:  alphanumerics plus `_`, `.`, `-` (a leading dot is legal: `.github`), so dot segments are rejected explicitly below.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const DOTTED_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

// `REPO_RE` admits `.` and `..`, which would escape the clone root like a bad owner; the owner pattern already rejects them.
const DOT_SEGMENTS = new Set(['.', '..']);

// SSH remote: git@host:path (optionally `ssh://git@host/path`).
const SSH_RE = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](\S+)$/i;

// Any scheme (or none), optional userinfo: host[:port][/path]. Anchored at the host so `https://evil.com/github.com/o/r` is NOT a GitHub repo, and whitespace-free so `github.com/a b/c` is rejected.
const HTTP_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^/@\s]+@)?([^/?#\s]+)(\/\S*)?$/;

// Path words that begin a host's own UI route rather than another namespace segment (GitLab's modern deep links use `/-/`, handled separately; legacy GitLab and every GitHub deep link put the route word directly after the project).
const RESERVED_PATH_SEGMENTS = new Set([
  'tree', 'blob', 'raw', 'commit', 'commits', 'compare', 'branches', 'tags',
  'releases', 'issues', 'pull', 'pulls', 'merge_requests', 'wiki', 'wikis',
  'actions', 'pipelines', 'settings', 'activity', 'network', 'graphs', 'blame',
  // GitLab serves these off the project path with no `/-/` marker; without them a badge or upload URL parses as a deeper namespace.
  'badges', 'uploads', 'archive', 'edit', 'forks', 'starrers', 'members',
  'artifacts', 'jobs', 'boards', 'milestones', 'labels', 'snippets',
  'environments', 'analytics', 'insights', 'hooks', 'container_registry',
]);

/**
 * Parse a repository URL into `{ host, provider, owner, repo }`, or null when it isn't a repository on a supported host (or has a path-unsafe owner/repo). `owner` is a single login on GitHub and
 * may be a `group/subgroup` path on GitLab; every segment is validated.
 *
 * @param {string} url
 * @returns {{ host: string, provider: string, owner: string, repo: string } | null}
 */
export function parseRepoUrl(url) {
  if (!url) return null;
  const normalized = String(url).trim();
  // A backslash defeats the host anchor: WHATWG maps `\` to `/` in the authority, so `https://evil.example.com\@github.com/o/r` resolves to evil.example.com in a browser while the regex reads github.com;
  // the link would be STORED and rendered as a trusted repo pointing at the attacker.
  if (normalized.includes('\\')) return null;

  const match = normalized.match(SSH_RE) || normalized.match(HTTP_RE);
  if (!match) return null;

  const host = match[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const hostConfig = REPO_HOSTS[host];
  if (!hostConfig) return null;

  // Drop the query/hash, then GitLab's `/-/` deep-link separator. GitHub's owner/repo pair is fixed, so identify those operands before any route words (a repo may itself be named `issues`, `settings` or `tree`).
  let path = (match[2] || '').split(/[?#]/)[0].replace(/^\//, '');
  const dashIndex = path.indexOf('/-/');
  if (dashIndex !== -1) path = path.slice(0, dashIndex);

  const pathSegments = path.split('/').filter(Boolean);
  const { maxDepth, allowDots } = hostConfig.namespace;
  let segments = pathSegments;
  if (hostConfig.flatClonePath) {
    segments = pathSegments.slice(0, maxDepth + 1);
  } else {
    const routeIndex = pathSegments.findIndex((segment, index) =>
      index >= 2 && RESERVED_PATH_SEGMENTS.has(segment.toLowerCase()));
    if (routeIndex !== -1) segments = pathSegments.slice(0, routeIndex);
  }
  if (segments.length < 2) return null;

  // Past the cap the path is a deep link into the project, not a deeper namespace (reading it so would create directories inside an existing checkout).
  if (segments.length > maxDepth + 1) return null;

  const ownerSegments = segments.slice(0, -1);
  const repo = segments[segments.length - 1].replace(/\.git$/i, '');

  const ownerPattern = allowDots ? DOTTED_OWNER_RE : OWNER_RE;
  if (!ownerSegments.every(segment => ownerPattern.test(segment))) return null;
  if (!repo || DOT_SEGMENTS.has(repo) || !REPO_RE.test(repo)) return null;

  return {
    host,
    provider: hostConfig.provider,
    owner: ownerSegments.join('/'),
    repo,
  };
}

/** True when the URL points at a repository on a supported host. */
export function isRepoUrl(url) {
  return parseRepoUrl(url) !== null;
}

/** The `https` clone URL for a parsed repo. */
export function repoCloneUrl({ host, owner, repo }) {
  return `https://${host}/${owner}/${repo}.git`;
}

/** The browsable web URL for a parsed repo, for records that store the scp-style SSH remote a browser can't follow. */
export function repoBrowseUrl({ host, owner, repo }) {
  return `https://${host}/${owner}/${repo}`;
}

/**
 * Parse a URL only when it is a GitHub repository, for callers whose downstream really is GitHub-specific (the Eidoverse worlds repo, pushed to with a GitHub token), NOT the Brain's repo capture.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, isGitHub: true } | null}
 */
export function parseGitHubUrl(url) {
  const parsed = parseRepoUrl(url);
  return parsed?.provider === 'github' ? { owner: parsed.owner, repo: parsed.repo, isGitHub: true } : null;
}

/** True when the URL points at a GitHub repository specifically. */
export function isGitHubRepoUrl(url) {
  return parseGitHubUrl(url) !== null;
}
