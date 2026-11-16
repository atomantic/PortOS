// Helpers for resolving forge (GitHub/GitLab) identity from git remote and PR/MR URLs.
//
// `parseGitRemote`, `parseGitHubOwnerFromRemote`, `pickGhAccountForOwner`, `detectForgeCli`,
// `parsePullRequestUrl` — GitHub/GitLab remote + PR/MR URL parsers and forge/account selectors used by
// `git.js`. No child-process or network access; the one non-pure edge is `parseGitRemote`, which
// canonicalizes a personal SSH `Host` alias via a cached synchronous `~/.ssh/config` read
// (lib/sshHostAlias.js explains why that must happen at parse time).

import { resolveSshHostAlias } from './sshHostAlias.js';

/**
 * Parse a git remote URL into `{ host, owner }`. Returns null for unparseable input.
 * Examples:
 *   git@github.com:atomantic/PortOS.git    → { host: 'github.com', owner: 'atomantic' }
 *   https://gitlab.com/group/sub/proj.git  → { host: 'gitlab.com', owner: 'group' }
 *   git@gitlab.example.com:foo/bar.git     → { host: 'gitlab.example.com', owner: 'foo' }
 *
 * `host` is the host the remote actually connects to: an SSH alias (`git@github-acme:...` with
 * `HostName github.com`) resolves to `github.com`, so downstream forge/CLI/API decisions match what
 * `git` and `gh` do.
 */
export function parseGitRemote(url) {
  if (!url) return null;
  // SSH: git@HOST:OWNER/REPO[.git]   (REPO can contain '/' for GitLab subgroups,
  //                                   but we only need the top-level owner here)
  const ssh = url.match(/^git@([^:]+):([^/]+)\/.+?(?:\.git)?$/);
  if (ssh) return { host: resolveSshHostAlias(ssh[1]), owner: ssh[2] };
  // HTTPS: https://HOST/OWNER/REPO[.git]
  // No alias resolution: ssh config applies to SSH only, and resolving an `https://` remote that
  // collides with an alias would point `gh --repo` + token overlay at the wrong API host.
  const https = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/.+?(?:\.git)?$/);
  if (https) return { host: https[1], owner: https[2] };
  return null;
}

/**
 * Back-compat: returns just the owner login when the remote is on github.com.
 */
export function parseGitHubOwnerFromRemote(url) {
  const parsed = parseGitRemote(url);
  return parsed?.host === 'github.com' ? parsed.owner : null;
}

/**
 * Pick which logged-in gh/glab account should auth against a repo owned by `ownerLogin`.
 * Case-insensitive exact match; returns null if no logged-in account matches the owner.
 */
export function pickGhAccountForOwner(ownerLogin, availableAccounts) {
  if (!ownerLogin || !availableAccounts?.length) return null;
  const lower = ownerLogin.toLowerCase();
  return availableAccounts.find(a => a.toLowerCase() === lower) || null;
}

/**
 * Pick which forge CLI to use for a given remote host.
 *   github.com                 → 'gh'
 *   gitlab.com / *gitlab*         → 'glab'   (covers self-hosted GitLab like gitlab.example.com)
 *   falsy / null / undefined / '' → 'unknown' (unresolved host; cannot assume gh)
 *   anything else              → 'gh'     (default; harmless when gh isn't authed for that host)
 */
export function detectForgeCli(host) {
  if (!host) return 'unknown';
  if (host === 'github.com') return 'gh';
  if (host === 'gitlab.com' || /(^|\.)gitlab\./i.test(host)) return 'glab';
  return 'gh';
}

/**
 * Parse a PR / MR URL into { host, owner, repo, number }. Returns null on bad input.
 * Handles GitHub (`/pull/N`) and GitLab (`/-/merge_requests/N`) URLs, including
 * GitLab projects nested in subgroups (the entire group path becomes `owner`)
 * and URLs with trailing segments such as `/files`, `/commits`, `?query`, `#hash`.
 */
export function parsePullRequestUrl(url) {
  if (!url || typeof url !== 'string') return null;

  let parsed;
  // `new URL` throws on malformed input; a structured null is wanted (the no-try/catch rule covers
  // request handlers, not validation helpers).
  try { parsed = new URL(url); } catch { return null; }

  // Only forge web URLs: reject file://, ftp://, javascript:, which could reach `gh api --hostname`
  // or `glab` with a misleading or empty host.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // `new URL` accepts `https:///path` and `http://:8080/...` with an empty hostname; a host-less PR URL is meaningless.
  if (!parsed.hostname) return null;

  // Reject explicit ports: `parsed.hostname` is used below, so a custom port would be silently
  // dropped and misroute the request (unsupported until a separate port field exists).
  if (parsed.port) return null;

  const host = parsed.hostname;
  const segments = parsed.pathname.split('/').filter(Boolean);

  // GitHub: /<owner>/<repo>/pull/<number>[/<more>]. STRICTLY two segments before `pull`, or
  // /owner/repo/extra/pull/1 would mis-parse.
  if (segments.length >= 4 && segments[2] === 'pull') {
    const number = Number(segments[3]);
    if (Number.isInteger(number) && number > 0) {
      return { host, owner: segments[0], repo: segments[1], number };
    }
  }

  // GitLab: /<group>[/<subgroup>...]/<project>/-/merge_requests/<number>[/<more>]
  // Locate the `-/merge_requests/<n>` triple anchored at any depth.
  for (let i = segments.length - 3; i >= 2; i--) {
    if (segments[i] === '-' && segments[i + 1] === 'merge_requests') {
      const number = Number(segments[i + 2]);
      if (Number.isInteger(number) && number > 0) {
        const project = segments.slice(0, i);
        if (project.length >= 2) {
          // owner = full group/subgroup path, repo = final project segment
          return {
            host,
            owner: project.slice(0, -1).join('/'),
            repo: project[project.length - 1],
            number,
          };
        }
      }
    }
  }

  return null;
}
