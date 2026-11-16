/**
 * Reads and classifies git origin remotes: `getOriginInfo`, `classifyOriginRemote`, `parseGitRemoteUrl`,
 * `readRemoteUrl`, `isUpstreamOwner`, `isUpstreamFullName`, `UPSTREAM_OWNER`/`UPSTREAM_REPO`
 *
 * Used by self-update and managed integrations to detect forks.
 */

import { execGit } from './execGit.js';
import { PATHS } from './fileUtils.js';
import { resolveSshHostAlias } from './sshHostAlias.js';

export const UPSTREAM_OWNER = 'atomantic';
export const UPSTREAM_REPO = 'PortOS';
export const UPSTREAM_FULL_NAME = `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`;

/** Return whether an owner or owner/repository name identifies PortOS upstream. */
export function isUpstreamOwner(fullNameOrOwner) {
  if (typeof fullNameOrOwner !== 'string') return false;
  const owner = fullNameOrOwner.trim().split('/')[0];
  return owner.toLowerCase() === UPSTREAM_OWNER.toLowerCase();
}

/** Return whether a full owner/repository name identifies PortOS upstream. */
export function isUpstreamFullName(fullName) {
  return typeof fullName === 'string' && fullName.trim().toLowerCase() === UPSTREAM_FULL_NAME.toLowerCase();
}

/**
 * Strip `://user:token@` credentials so a PAT in an https remote can't leak into responses or logs.
 * SCP-style remotes carry only a username, so they are left alone (redacting would corrupt the URL).
 */
export function redactRemoteUrlCredentials(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/:\/\/[^@/\s]+@/, '://***@');
}

/**
 * Parse a git remote URL (SSH or HTTPS, any host) into { host, owner, repo }, or null unless it has
 * exactly two path segments after the host (`git@host:owner/repo/extra` would yield a `fullName` that
 * breaks `gh repo sync` and fork classification). Accepts scp-style (with optional leading port, e.g.
 * `git@ssh.github.com:443/owner/repo.git`), `ssh://` and `https://` forms.
 *
 * The returned `host` has no `:port` and a personal SSH `Host` alias (via `~/.ssh/config`, see
 * lib/sshHostAlias.js) is resolved to the host it connects to, since callers compare against e.g.
 * `github.com` to pick a forge.
 */
export function parseGitRemoteUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  // Strip one trailing slash so `…/owner/repo/` parses but `…/owner/repo/extra` still fails.
  const trimmed = url.trim().replace(/\/$/, '');

  const stripGit = (s) => s.replace(/\.git$/i, '');
  // Strip an optional `:port` so `github.com:443` and `github.com` compare equal.
  const stripPort = (h) => h.replace(/:\d+$/, '');
  // Port first: an alias is written bare in ssh config, so `github-acme:22` needs its port removed before lookup.
  const normalizeHost = (h) => resolveSshHostAlias(stripPort(h));
  // Only SSH branches resolve aliases; an `https://` remote colliding with an alias keeps its literal
  // host or `gh --repo` + token overlay target the wrong API host.
  const normalizeUrlHost = (scheme, h) => (scheme === 'ssh' ? normalizeHost(h) : stripPort(h));

  // SCP-style SSH: git@host:[port/]owner/repo(.git); the optional `(?:\d+\/)?` is GitHub's
  // `git@ssh.github.com:443/OWNER/REPO.git` port-prefix variant.
  const scpMatch = trimmed.match(/^[a-zA-Z0-9._-]+@([^:]+):(?:\d+\/)?([^/]+)\/([^/]+)$/);
  if (scpMatch) {
    return { host: normalizeHost(scpMatch[1]), owner: scpMatch[2], repo: stripGit(scpMatch[3]) };
  }

  // URL-style: scheme://[user@]host(:port)/owner/repo(.git) — repo segment
  // cannot contain '/'.
  const urlMatch = trimmed.match(/^([a-zA-Z]+):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/);
  if (urlMatch) {
    return { host: normalizeUrlHost(urlMatch[1].toLowerCase(), urlMatch[2]), owner: urlMatch[3], repo: stripGit(urlMatch[4]) };
  }

  return null;
}

/** Read the current repo's `origin` URL; null when not a git repo or no `origin` (e.g. tarball install). */
export async function readOriginRemoteUrl(cwd = PATHS.root) {
  return readRemoteUrl('origin', cwd);
}

/** Read a named git remote without exposing it to a shell. */
export async function readRemoteUrl(remote, cwd = PATHS.root) {
  if (typeof remote !== 'string' || !/^[A-Za-z0-9._-]+$/.test(remote)) return null;
  const result = await execGit(['remote', 'get-url', remote], cwd, { ignoreExitCode: true });
  if (result.exitCode !== 0) return null;
  const url = result.stdout.trim();
  return url || null;
}

/**
 * Inspect the local git origin remote and classify it against the upstream atomantic/PortOS repo.
 * Returns `{ hasOrigin, originUrl, host, owner, repo, fullName, isUpstream, isGithub, isFork }`.
 * `isFork` is any GitHub repo with a different owner than upstream (see below); comparison is
 * case-insensitive.
 */
export function classifyOriginRemote(originUrl, {
  upstreamOwner = UPSTREAM_OWNER,
  upstreamRepo = UPSTREAM_REPO,
} = {}) {
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

  // The URL reaches the client via getUpdateStatus(); scrub embedded PAT/basic-auth credentials.
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
  const ownerMatchesUpstream = parsed.owner.toLowerCase() === upstreamOwner.toLowerCase();
  const repoMatchesUpstream = parsed.repo.toLowerCase() === upstreamRepo.toLowerCase();
  const isUpstream = isGithub && ownerMatchesUpstream && repoMatchesUpstream;
  // Fork: different owner on GitHub, regardless of repo name. A renamed fork is still the PortOS
  // checkout; requiring a name match made `isFork` go false on rename (breaking the fork panel,
  // sync-fork route and divergence check) while `gh repo sync` kept working via GitHub's slug redirect.
  const isFork = isGithub && !ownerMatchesUpstream;

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

/**
 * Read and classify one checkout's origin against a canonical upstream (default atomantic/PortOS;
 * managed integrations may supply their own owner/repo).
 */
export async function getOriginInfo(cwd = PATHS.root, upstream = {}) {
  const originUrl = await readOriginRemoteUrl(cwd);
  return classifyOriginRemote(originUrl, upstream);
}
