// Pure helpers for resolving forge (GitHub/GitLab) identity from git remote
// and PR/MR URLs. No child-process or network access — these are string
// parsers and selectors. The orchestration that shells out to `gh`/`glab`
// (resolveForgeForRepo, createPR, requestCopilotReview) lives in
// server/services/git.js and composes these.

/**
 * Parse a git remote URL into `{ host, owner }`. Returns null for unparseable input.
 * Examples:
 *   git@github.com:atomantic/PortOS.git    → { host: 'github.com', owner: 'atomantic' }
 *   https://gitlab.com/group/sub/proj.git  → { host: 'gitlab.com', owner: 'group' }
 *   git@gitlab.example.com:foo/bar.git     → { host: 'gitlab.example.com', owner: 'foo' }
 */
export function parseGitRemote(url) {
  if (!url) return null;
  // SSH: git@HOST:OWNER/REPO[.git]   (REPO can contain '/' for GitLab subgroups,
  //                                   but we only need the top-level owner here)
  const ssh = url.match(/^git@([^:]+):([^/]+)\/.+?(?:\.git)?$/);
  if (ssh) return { host: ssh[1], owner: ssh[2] };
  // HTTPS: https://HOST/OWNER/REPO[.git]
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
 *   github.com         → 'gh'
 *   gitlab.com / *gitlab* → 'glab'   (covers self-hosted GitLab like gitlab.example.com)
 *   anything else      → 'gh'        (default; harmless when gh isn't authed for that host)
 */
export function detectForgeCli(host) {
  if (!host) return 'gh';
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
  // new URL throws on malformed input; we want a structured null instead so a try
  // wrapper here is the right call (the project's "no try/catch" rule covers
  // request handlers, not URL validation helpers).
  try { parsed = new URL(url); } catch { return null; }

  // Only forge web URLs are valid input — reject file://, ftp://, javascript:,
  // etc., which can otherwise sneak through to downstream `gh api --hostname`
  // or `glab` calls with a misleading or empty host.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // `new URL` accepts `https:///path` and `http://:8080/...` — both yield an
  // empty hostname. Reject those: a host-less PR URL is meaningless.
  if (!parsed.hostname) return null;

  // Reject explicit ports (`https://github.com:8443/...`). We use
  // `parsed.hostname` below (not `host`), so a custom port would be silently
  // dropped and route the request to the wrong server. Custom-port forges
  // aren't supported until the port is plumbed through a separate field.
  if (parsed.port) return null;

  const host = parsed.hostname;
  const segments = parsed.pathname.split('/').filter(Boolean);

  // GitHub: /<owner>/<repo>/pull/<number>[/<more>]
  // GitHub PR URLs are STRICTLY two segments before `pull` — anything else
  // (e.g. /owner/repo/extra/pull/1) is invalid and would silently mis-parse
  // if we just took the last segment as `repo`. Require segments[2] === 'pull'.
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
