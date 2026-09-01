/**
 * Git repository URL parsing — MIRROR of `server/lib/repoUrl.js`
 * (authoritative there).
 *
 * The Brain capture boxes preview what the server will do with a bare URL: a
 * github.com / gitlab.com repo gets cloned, which unlocks the post-clone agent
 * options (malware scan / learn-from-repo). A looser client offers those options
 * for a URL the server files as a plain bookmark; a tighter one hides them for a
 * repo that will in fact be cloned.
 *
 * Port any change from the server copy verbatim; parity is enforced by
 * `server/lib/repoUrl.mirror.test.js`.
 */

// The host allowlist, and the two behaviors that actually differ between hosts.
// They live IN the table rather than as `host === 'github.com'` branches further
// down, so adding a host is one entry here and nothing else — and so each flag
// has to be decided deliberately for the new host rather than inherited from
// whichever existing host the branch happened to compare against.
//
//   provider           stable id stored on a link record (`repoHost` holds the
//                      hostname itself)
//   namespace.maxDepth how many path segments before the project may be the
//                      namespace. 1 = no subgroups (GitHub: anything past
//                      owner/repo is a deep link). GitLab nests subgroups, but
//                      the depth is CAPPED rather than unbounded: a bare GitLab
//                      URL carries no marker separating `group/sub/project` from
//                      `group/project/route/...`, so an unbounded walk reads a
//                      project asset URL as a deep namespace and manufactures
//                      directories INSIDE an existing clone. The cap also bounds
//                      the on-disk layout, which `repoCloner`'s staging sweep
//                      derives its recursion depth from.
//   namespace.allowDots whether a namespace segment may contain a dot. GitHub
//                      logins may not; GitLab group paths may. Keeping it off
//                      for the flat-clone host is also what makes a hostname
//                      collision impossible (`github.com/gitlab.com/x` cannot
//                      parse, so it cannot land on another host's clone root).
//   flatClonePath      LEGACY CARVE-OUT — clone to `<owner>/<repo>` with no
//                      hostname level, so clones made before PortOS supported a
//                      second host stay exactly where their link record says
//                      they are. Never set this for a newly added host.
export const REPO_HOSTS = Object.freeze({
  'github.com': { provider: 'github', namespace: { maxDepth: 1, allowDots: false }, flatClonePath: true },
  'gitlab.com': { provider: 'gitlab', namespace: { maxDepth: 3, allowDots: true }, flatClonePath: false },
});

/** The deepest `<host>/<namespace…>/<repo>` layout any host in the table produces. */
export const MAX_REPO_PATH_DEPTH = Object.values(REPO_HOSTS).reduce(
  (deepest, { namespace, flatClonePath }) => Math.max(deepest, (flatClonePath ? 0 : 1) + namespace.maxDepth + 1),
  0,
);

// The owner/repo pair is a PATH OPERAND, not just a label: the cloner clones
// into `join(reposDir, …owner, repo)` and the resulting `localPath` is later
// handed to an agent as the directory to scan/study. So every segment is
// matched against the character sets the hosts actually allow, NOT "anything
// but a slash" — the loose form parsed `https://github.com/../evil` as owner
// `..`, which resolves OUTSIDE the managed clone root.
//   owner: a login (or a GitLab group/subgroup). Both forms REQUIRE a leading
//          alphanumeric, which is what makes `.` and `..` unrepresentable; the
//          dotted form is gated per host (see `namespace.allowDots`).
//   repo:  alphanumerics plus `_`, `.`, `-` — a leading dot is legal (`.github`
//          is a real repository), so dot segments are rejected explicitly below.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const DOTTED_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

// `REPO_RE`'s character class admits the dot segments `.` and `..`, which would
// escape (or collapse to) the clone root the same way a bad owner does. The
// owner pattern already rejects them by requiring a leading alphanumeric.
const DOT_SEGMENTS = new Set(['.', '..']);

// SSH remote: git@host:path (optionally `ssh://git@host/path`).
const SSH_RE = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](\S+)$/i;

// Any scheme (or none), optional userinfo: host[:port][/path]. Anchored at the
// host so `https://evil.com/github.com/o/r` is NOT read as a GitHub repo, and
// whitespace-free end-to-end so `github.com/a b/c` is rejected outright.
const HTTP_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^/@\s]+@)?([^/?#\s]+)(\/\S*)?$/;

// Path words that begin a host's own UI route rather than another namespace
// segment. GitLab's modern deep links use the `/-/` separator (handled
// separately), but its legacy links — and every GitHub deep link — put the
// route word directly after the project, so the segment walk stops here.
const RESERVED_PATH_SEGMENTS = new Set([
  'tree', 'blob', 'raw', 'commit', 'commits', 'compare', 'branches', 'tags',
  'releases', 'issues', 'pull', 'pulls', 'merge_requests', 'wiki', 'wikis',
  'actions', 'pipelines', 'settings', 'activity', 'network', 'graphs', 'blame',
  // GitLab serves these directly off the project path with no `/-/` marker, so
  // without them a badge or upload URL parses as a deeper namespace.
  'badges', 'uploads', 'archive', 'edit', 'forks', 'starrers', 'members',
  'artifacts', 'jobs', 'boards', 'milestones', 'labels', 'snippets',
  'environments', 'analytics', 'insights', 'hooks', 'container_registry',
]);

/**
 * Parse a repository URL into `{ host, provider, owner, repo }`, or null when
 * the URL isn't a repository on a supported host (or names a path-unsafe
 * owner/repo).
 *
 * `owner` is a single login on GitHub and may be a `group/subgroup` path on
 * GitLab; every one of its segments is validated, so it stays path-safe.
 *
 * @param {string} url
 * @returns {{ host: string, provider: string, owner: string, repo: string } | null}
 */
export function parseRepoUrl(url) {
  if (!url) return null;
  const normalized = String(url).trim();
  // A backslash defeats the host anchor: WHATWG maps `\` to `/` inside the
  // authority, so `https://evil.example.com\@github.com/o/r` resolves to
  // evil.example.com in a browser while the regex below reads github.com. The
  // clone would still go to the real github.com (repoCloneUrl rebuilds from the
  // parsed host), but the link would be STORED and rendered as a trusted repo
  // whose href points at the attacker.
  if (normalized.includes('\\')) return null;

  const match = normalized.match(SSH_RE) || normalized.match(HTTP_RE);
  if (!match) return null;

  const host = match[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const hostConfig = REPO_HOSTS[host];
  if (!hostConfig) return null;

  // Drop the query/hash, then GitLab's `/-/` deep-link separator. GitHub has a
  // fixed owner/repo pair, so identify those two operands before looking at any
  // later route words — a repository itself may be named `issues`, `settings`,
  // or `tree`, and arbitrary GitHub deep links are still valid repo URLs.
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

  // Past the cap the path is a deep link into the project, not a deeper
  // namespace — reading it as one would clone into (and create directories
  // inside) an existing checkout.
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

/**
 * True when the URL points at a repository on a supported host.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isRepoUrl(url) {
  return parseRepoUrl(url) !== null;
}

/**
 * The browsable web URL for a parsed repo — what to `href` when a record stores
 * the scp-style SSH remote a browser can't follow.
 *
 * @param {{ host: string, owner: string, repo: string }} parsed
 * @returns {string}
 */
export function repoBrowseUrl({ host, owner, repo }) {
  return `https://${host}/${owner}/${repo}`;
}

/**
 * Parse a URL only when it is a GitHub repository. The GitHub-only callers are
 * the ones whose downstream really is GitHub-specific (the Eidoverse worlds
 * repo, which is pushed to with a GitHub token), NOT the Brain's repo capture.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, isGitHub: true } | null}
 */
export function parseGitHubUrl(url) {
  const parsed = parseRepoUrl(url);
  return parsed?.provider === 'github' ? { owner: parsed.owner, repo: parsed.repo, isGitHub: true } : null;
}

/**
 * True when the URL points at a GitHub repository specifically.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isGitHubRepoUrl(url) {
  return parseGitHubUrl(url) !== null;
}
