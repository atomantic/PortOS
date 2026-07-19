// Per-app "work tracker" resolution — where a managed app's autonomous work
// items live: PLAN.md, a GitHub issue tracker, a GitLab issue tracker, or JIRA.
//
// Each managed app carries a `workTracker` field (default `'auto'`). `'auto'`
// resolves to a concrete tracker from the app's git `origin` host: a github.com
// remote → GitHub issues, a gitlab.* remote → GitLab issues, anything else (or
// no remote) → PLAN.md. JIRA is never auto-selected — it requires explicit
// per-app JIRA config (`app.jira`) — so a user picks it deliberately.
//
// The pure mappers (hostToWorkTracker / forgeCliForTracker / trackerToClaimTaskType
// / resolveWorkTracker / hostFromOriginUrl) are side-effect-free and unit-tested.
// resolveAppWorkTracker is the async wrapper that reads the app's origin URL via
// readOriginRemoteUrl and extracts the host with hostFromOriginUrl — it shells
// out to git, mirroring gitRemote.js (which also lives in lib/ despite running
// `git`). See server/services/cosTaskGenerator.js for the claim-work router
// that consumes trackerToClaimTaskType.

import { readOriginRemoteUrl } from './gitRemote.js';

// Every selectable value (UI + Zod enum). `'auto'` is the default; the rest are
// concrete sources.
export const WORK_TRACKERS = ['auto', 'plan', 'github', 'gitlab', 'jira'];

// The concrete sources `'auto'` can resolve to (i.e. WORK_TRACKERS minus auto).
export const CONCRETE_WORK_TRACKERS = WORK_TRACKERS.filter(t => t !== 'auto');

export const DEFAULT_WORK_TRACKER = 'auto';

const TRACKER_LABELS = {
  auto: 'Auto (detect from git origin)',
  plan: 'PLAN.md',
  github: 'GitHub Issues',
  gitlab: 'GitLab Issues',
  jira: 'JIRA',
};

/** Human-readable label for a tracker value (falls back to the raw value). */
export function workTrackerLabel(tracker) {
  return TRACKER_LABELS[tracker] || tracker;
}

/**
 * Map a git remote host to its concrete forge work tracker, or null when the
 * host isn't a recognized forge (so the caller falls back to PLAN.md). Mirrors
 * the host classification in gitForge.detectForgeCli — covers github.com /
 * gitlab.com plus self-hosted enterprise hosts (github.*, gitlab.*).
 */
export function hostToWorkTracker(host) {
  if (!host || typeof host !== 'string') return null;
  const h = host.toLowerCase();
  if (h === 'github.com' || /(^|\.)github\./.test(h)) return 'github';
  if (h === 'gitlab.com' || /(^|\.)gitlab\./.test(h)) return 'gitlab';
  return null;
}

/**
 * True when `host` is a GitHub-family host — github.com AND self-hosted GitHub
 * Enterprise (github.*). This is the enterprise-aware replacement for the
 * github.com-only `getOriginInfo().isGithub` gate: `isGithub` drives PortOS's
 * own fork/update flow (upstream lives on github.com), so reusing it to decide
 * whether a repo's issues/PRs live on GitHub silently excluded enterprise repos.
 * Shared by prWatcher, branchReconcile, and issueReconcile so the three stay
 * consistent about what counts as "a GitHub repo".
 */
export function isGithubHost(host) {
  return hostToWorkTracker(host) === 'github';
}

/**
 * Build the host-qualified `HOST/OWNER/REPO` selector for `gh --repo` from a
 * `getOriginInfo()` result, or null when the origin isn't a usable GitHub repo
 * (no origin, unparsed owner/repo, or a non-GitHub host). The host qualifier is
 * load-bearing: a bare `OWNER/REPO` defaults `gh` to github.com, so enterprise
 * repos would be silently queried against github.com — and it stays
 * deterministic on a fork+upstream checkout where gh's cwd remote-detection
 * ambiguously resolves to the parent repo. Pairs the isGithubHost gate with the
 * selector so prWatcher, branchReconcile, and issueReconcile share one
 * definition of "a resolvable GitHub repo" instead of three hand-copied ones.
 * (No separate `hasOrigin` check: isGithubHost is true only for a real GitHub
 * host string, which getOriginInfo returns only when an origin exists.)
 *
 * Canonicalizes GitHub's SSH-over-443 alias: a `git@ssh.github.com:443/owner/repo`
 * remote parses to host `ssh.github.com`, but `gh --repo` reads the `HOST/` prefix
 * as the API host, so `ssh.github.com/owner/repo` would query the SSH endpoint and
 * silently return nothing. Only `github.com` has a documented `ssh.` alias, and an
 * enterprise host may legitimately begin with `ssh.` (`ssh.github.acme.example`),
 * so canonicalize the exact known alias rather than stripping `ssh.` from any host.
 * @param {{host?:string|null, fullName?:string|null}} origin
 * @returns {string|null}
 */
export function githubRepoSpec(origin) {
  if (!origin?.fullName || !isGithubHost(origin.host)) return null;
  const apiHost = /^ssh\.github\.com$/i.test(origin.host) ? 'github.com' : origin.host;
  return `${apiHost}/${origin.fullName}`;
}

/**
 * Which forge CLI a concrete tracker drives: github → `gh`, gitlab → `glab`.
 * PLAN.md and JIRA have no forge CLI, so they return null.
 */
export function forgeCliForTracker(tracker) {
  if (tracker === 'github') return 'gh';
  if (tracker === 'gitlab') return 'glab';
  return null;
}

/**
 * The CoS claim task type that ships work from a concrete tracker. The
 * claim-work router (cosTaskGenerator) delegates to one of these prompt bodies
 * after resolving the app's tracker:
 *   plan   → plan-task            (PLAN.md flow)
 *   github → claim-issue          (gh issue flow)
 *   gitlab → claim-issue-gitlab   (glab issue flow)
 *   jira   → claim-issue-jira     (JIRA sprint-ticket flow)
 * Returns null for an unknown tracker.
 *
 * Note: 'jira' routes to the per-ticket `claim-issue-jira` flow (claim ONE ready
 * sprint ticket, ship it, move it To Do → In Progress → In Review), NOT the
 * broader `jira-sprint-manager` triage job — that remains a separate standalone
 * scheduled task.
 */
export function trackerToClaimTaskType(tracker) {
  switch (tracker) {
    case 'plan': return 'plan-task';
    case 'github': return 'claim-issue';
    case 'gitlab': return 'claim-issue-gitlab';
    case 'jira': return 'claim-issue-jira';
    default: return null;
  }
}

/**
 * Pure resolution: given a configured `workTracker` value (possibly `'auto'`,
 * undefined, or junk) and a known origin `host`, produce the concrete tracker.
 *
 * Returns `{ configured, resolved, source }`:
 *   - configured: the normalized stored value ('auto' for absent/invalid)
 *   - resolved:   the concrete tracker ('plan' | 'github' | 'gitlab' | 'jira')
 *   - source:     'configured' (explicit choice), 'origin' (auto → host), or
 *                 'fallback' (auto with no recognizable forge host → PLAN.md)
 */
export function resolveWorkTracker({ configured, host } = {}) {
  const value = CONCRETE_WORK_TRACKERS.includes(configured) ? configured : 'auto';
  if (value !== 'auto') {
    return { configured: value, resolved: value, source: 'configured' };
  }
  const fromHost = hostToWorkTracker(host);
  if (fromHost) return { configured: 'auto', resolved: fromHost, source: 'origin' };
  return { configured: 'auto', resolved: 'plan', source: 'fallback' };
}

/**
 * Extract just the host from a git origin URL — only the host is needed to
 * classify the forge, so this handles EVERY remote form in one pass rather than
 * chaining structure-validating owner/repo parsers (which variously reject
 * GitLab subgroup paths, `ssh://` scheme + subgroups, or ports). Returns null
 * for unparseable input. Handles:
 *   - scheme URLs: `https://`, `ssh://`, `git://` … with optional `user[:pw]@`
 *     and `:port`, and ANY path depth (so GitLab `group/subgroup/repo` works)
 *   - scp-style: `[user@]host:path`
 *
 * Embedded credentials are dropped inherently — the `user[:token]@` segment is
 * matched and discarded, never returned — so a PAT in an https remote can't
 * leak through `GET /api/apps/:id/work-tracker`. Ports are stripped too.
 */
export function hostFromOriginUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // scheme://[userinfo@]host[:port]/...  — host is the run up to the next / : @
  const scheme = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/);
  if (scheme) return scheme[1] || null;
  // scp-style [user@]host:path
  const scp = trimmed.match(/^(?:[^@/]+@)?([^/:]+):/);
  if (scp) return scp[1] || null;
  return null;
}

/**
 * Resolve a managed app's effective work tracker, reading its git origin host
 * when needed. Returns `{ configured, resolved, host, forge, source }` where
 * `forge` is the CLI ('gh' | 'glab' | null) for the resolved tracker. Never
 * throws — a missing repo / origin degrades to host=null (→ PLAN.md fallback).
 */
export async function resolveAppWorkTracker(app) {
  const configured = app?.workTracker;
  let host = null;
  if (app?.repoPath) {
    const url = await readOriginRemoteUrl(app.repoPath).catch(() => null);
    host = hostFromOriginUrl(url);
  }
  const base = resolveWorkTracker({ configured, host });
  return { ...base, host, forge: forgeCliForTracker(base.resolved) };
}
