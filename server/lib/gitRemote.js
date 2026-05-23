import { execGit } from './execGit.js';
import { PATHS } from './fileUtils.js';

export const UPSTREAM_OWNER = 'atomantic';
export const UPSTREAM_REPO = 'PortOS';
export const UPSTREAM_FULL_NAME = `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`;

/**
 * Strip any `://user:token@` credentials from a URL so a PAT embedded in an
 * https remote can't leak into API responses, logs, or telemetry. SCP-style
 * remotes (`user@host:path`) carry only a username (no secret) so we leave
 * those alone — redacting them would corrupt the URL.
 */
export function redactRemoteUrlCredentials(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/:\/\/[^@/\s]+@/, '://***@');
}

/**
 * Parse a git remote URL (SSH or HTTPS) into { host, owner, repo }.
 * Host-agnostic — accepts GitHub, GitLab, enterprise hosts, etc. Returns null
 * when the URL doesn't match an "owner/repo" shape (exactly two path segments
 * after the host). GitHub.com classification happens later in `getOriginInfo`.
 *
 * Handles:
 *   git@github.com:owner/repo.git
 *   git@ssh.github.com:443/owner/repo.git           (SCP variant with leading port)
 *   ssh://git@github.com/owner/repo.git
 *   ssh://git@github.com:443/owner/repo.git         (URL form with port)
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.enterprise.com:org/repo.git
 *
 * The returned `host` is always normalized (no trailing `:port`) so callers
 * comparing against e.g. `github.com` don't have to special-case ports.
 * Rejects URLs with extra path segments (e.g. `git@host:owner/repo/extra`)
 * since those would produce a `fullName` like `owner/repo/extra` that breaks
 * `gh repo sync` and fork classification.
 */
export function parseGitRemoteUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  // Strip a single trailing slash so `…/owner/repo/` parses, but
  // `…/owner/repo/extra` (extra path segment) still fails the regex.
  const trimmed = url.trim().replace(/\/$/, '');

  // Strip a trailing .git for both SSH and HTTPS variants
  const stripGit = (s) => s.replace(/\.git$/i, '');
  // Normalize host — strip an optional `:port` suffix so `github.com:443`
  // and `github.com` compare equal.
  const stripPort = (h) => h.replace(/:\d+$/, '');

  // SCP-style SSH: git@host:[port/]owner/repo(.git). repo segment cannot
  // contain '/'. The optional `(?:\d+\/)?` matches the GitHub-specific variant
  // `git@ssh.github.com:443/OWNER/REPO.git` where `443/` is a path-prefix
  // hop port.
  const scpMatch = trimmed.match(/^[a-zA-Z0-9._-]+@([^:]+):(?:\d+\/)?([^/]+)\/([^/]+)$/);
  if (scpMatch) {
    return { host: stripPort(scpMatch[1]), owner: scpMatch[2], repo: stripGit(scpMatch[3]) };
  }

  // URL-style: scheme://[user@]host(:port)/owner/repo(.git) — repo segment
  // cannot contain '/'.
  const urlMatch = trimmed.match(/^[a-zA-Z]+:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/);
  if (urlMatch) {
    return { host: stripPort(urlMatch[1]), owner: urlMatch[2], repo: stripGit(urlMatch[3]) };
  }

  return null;
}

/**
 * Read the current repo's `origin` remote URL. Returns null when the directory
 * isn't a git repo or has no `origin` remote (rare, e.g. a tarball install).
 */
export async function readOriginRemoteUrl(cwd = PATHS.root) {
  const result = await execGit(['remote', 'get-url', 'origin'], cwd, { ignoreExitCode: true });
  if (result.exitCode !== 0) return null;
  const url = result.stdout.trim();
  return url || null;
}

/**
 * Inspect the local git origin remote and classify it relative to the
 * upstream atomantic/PortOS repo.
 *
 * Returned shape:
 *   {
 *     hasOrigin: boolean,
 *     originUrl: string | null,
 *     host: string | null,         // e.g. "github.com"
 *     owner: string | null,
 *     repo: string | null,
 *     fullName: string | null,     // "owner/repo"
 *     isUpstream: boolean,         // origin == atomantic/PortOS on github.com
 *     isGithub: boolean,
 *     isFork: boolean              // a GitHub `<other>/PortOS` repo — strict
 *                                  // fork candidate: same repo name (case-
 *                                  // insensitive), different owner. A repo
 *                                  // with a different name (e.g. someone
 *                                  // forked-and-renamed) is NOT classified
 *                                  // as a fork because `gh repo sync` would
 *                                  // fail and the fork-aware UI would lie.
 *   }
 *
 * Comparison is case-insensitive (GitHub treats owner/repo names as such).
 */
export async function getOriginInfo(cwd = PATHS.root) {
  const originUrl = await readOriginRemoteUrl(cwd);
  if (!originUrl) {
    return {
      hasOrigin: false,
      originUrl: null,
      host: null,
      owner: null,
      repo: null,
      fullName: null,
      isUpstream: false,
      isGithub: false,
      isFork: false
    };
  }

  // The URL surfaces to the client via getUpdateStatus(); scrub any embedded
  // PAT/basic-auth credentials so they don't leak into API responses or logs.
  const safeUrl = redactRemoteUrlCredentials(originUrl);

  const parsed = parseGitRemoteUrl(originUrl);
  if (!parsed) {
    return {
      hasOrigin: true,
      originUrl: safeUrl,
      host: null,
      owner: null,
      repo: null,
      fullName: null,
      isUpstream: false,
      isGithub: false,
      isFork: false
    };
  }

  const isGithub = /(^|\.)github\.com$/i.test(parsed.host);
  const ownerMatchesUpstream = parsed.owner.toLowerCase() === UPSTREAM_OWNER.toLowerCase();
  const repoMatchesUpstream = parsed.repo.toLowerCase() === UPSTREAM_REPO.toLowerCase();
  const isUpstream = isGithub && ownerMatchesUpstream && repoMatchesUpstream;
  // Strict fork: same repo name, different owner, on GitHub. A renamed
  // GitHub repo (different name) doesn't count — `gh repo sync` would fail
  // and the fork-aware UI would mislead the user.
  const isFork = isGithub && repoMatchesUpstream && !ownerMatchesUpstream;

  return {
    hasOrigin: true,
    originUrl: safeUrl,
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
    fullName: `${parsed.owner}/${parsed.repo}`,
    isUpstream,
    isGithub,
    isFork
  };
}
