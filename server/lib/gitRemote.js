import { execGit } from './execGit.js';
import { PATHS } from './fileUtils.js';

export const UPSTREAM_OWNER = 'atomantic';
export const UPSTREAM_REPO = 'PortOS';
export const UPSTREAM_FULL_NAME = `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`;

/**
 * Parse a git remote URL (SSH or HTTPS) into { host, owner, repo }.
 * Returns null when the URL doesn't look like a GitHub-style "owner/repo" remote.
 *
 * Handles:
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.enterprise.com:org/repo.git
 */
export function parseGitRemoteUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();

  // Strip a trailing .git for both SSH and HTTPS variants
  const stripGit = (s) => s.replace(/\.git$/i, '');

  // SCP-style SSH: git@host:owner/repo(.git)
  const scpMatch = trimmed.match(/^[a-zA-Z0-9._-]+@([^:]+):([^/]+)\/(.+)$/);
  if (scpMatch) {
    return { host: scpMatch[1], owner: scpMatch[2], repo: stripGit(scpMatch[3]) };
  }

  // URL-style: scheme://[user@]host/owner/repo(.git)
  const urlMatch = trimmed.match(/^[a-zA-Z]+:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)\/?$/);
  if (urlMatch) {
    return { host: urlMatch[1], owner: urlMatch[2], repo: stripGit(urlMatch[3]) };
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
 *     isFork: boolean              // a GitHub remote that isn't upstream
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

  const parsed = parseGitRemoteUrl(originUrl);
  if (!parsed) {
    return {
      hasOrigin: true,
      originUrl,
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
  const isUpstream =
    isGithub &&
    parsed.owner.toLowerCase() === UPSTREAM_OWNER.toLowerCase() &&
    parsed.repo.toLowerCase() === UPSTREAM_REPO.toLowerCase();

  return {
    hasOrigin: true,
    originUrl,
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
    fullName: `${parsed.owner}/${parsed.repo}`,
    isUpstream,
    isGithub,
    isFork: isGithub && !isUpstream
  };
}
