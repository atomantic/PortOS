/**
 * PR Watcher service.
 *
 * Each PortOS-managed app can enable the `pr-watcher` scheduled task. On every
 * run the task polls the app's GitHub repo for pull requests newly opened
 * against the default branch and dispatches a CoS agent (running the
 * configurable `pr-watcher` prompt) for the new ones.
 *
 * "Newly opened" is tracked with a single high-water mark per app
 * (`prWatcherState.lastSeenPrNumber`) stored inline on the app record in
 * data/apps.json — GitHub PR numbers are monotonic and never reused, so any
 * PR with a number above the mark is one we haven't dispatched for yet. The
 * very first run baselines the mark to the current max open PR number WITHOUT
 * dispatching, so the watcher only fires for PRs opened after it was enabled
 * (matching "react whenever a PR is opened", not "re-process the backlog").
 *
 * Authorship gating (`taskMetadata.prAuthorFilter`): 'self' = PRs opened by the
 * gh-authenticated user (the operator / their automation), 'others' = everyone
 * else, 'any' = no gate.
 *
 * All gh access goes through the shared `execGh` wrapper. Functions here never
 * throw — they return structured `{ ok, reason, ... }` results — so the
 * scheduler tick that calls them (cosTaskGenerator) can't be crashed by a gh
 * failure on one app.
 */

import { execGh } from './github.js';
import { getAppById, updateApp } from './apps.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec, githubApiHost } from '../lib/workTracker.js';
import { PR_AUTHOR_FILTERS } from '../lib/validation.js';
import { safeJSONParse } from '../lib/fileUtils.js';

// Bound the gh query. The high-water mark (computePrCheck) advances to the max
// open PR number it saw, so it can only correctly drain a backlog it received
// in full: if `gh pr list` truncated the page, new PRs numbered below the
// page's minimum would be marked seen without ever dispatching. gh returns
// newest-first, so truncation drops the OLDEST new PRs. We set the cap high
// enough (200) that a single-user app's default branch realistically never
// truncates, and `checkPullRequests` emits a loud warning (never silent) if it
// ever does — at which point the operator should run the watcher again or raise
// the cap. 200 matches the limit github.js#syncRepos already uses.
const PR_LIST_LIMIT = 200;

// Cache the gh-authenticated login PER HOST, for the process lifetime. Host-keyed
// for two reasons: (1) `gh api` does NOT infer the host from the working
// directory's git remote the way `gh pr list` / `gh issue list` do — it hits the
// default host (github.com) unless given an explicit `--hostname`; (2) the
// operator is commonly a DIFFERENT login on github.com vs a self-hosted
// enterprise host, so one process-wide login would gate enterprise PRs against
// the wrong identity. Each host resolves once and is cached independently.
const _selfLoginCache = new Map();

/**
 * Resolve the gh-authenticated user's login on `host` (e.g. "alice" on
 * github.com, "alice_corp" on an enterprise host). Returns null when `host` is
 * falsy or gh isn't authenticated there — callers that need it for an author
 * gate must treat null as "can't gate, don't fire blindly".
 */
export async function getSelfLogin(host) {
  if (!host) return null;
  if (_selfLoginCache.has(host)) return _selfLoginCache.get(host);
  // `--hostname` is required: without it `gh api` targets github.com regardless
  // of cwd, resolving the wrong identity for an enterprise repo.
  const login = await execGh(['api', 'user', '--hostname', host, '--jq', '.login']).catch(() => null);
  // Only memoize a SUCCESSFUL lookup. Caching a null from a transient gh/auth
  // failure (keychain locked mid-tick, gh re-auth in progress) would wedge every
  // later self/others gate on this host into 'self-login-unavailable' until
  // process restart; leaving it unset lets the next tick retry once auth recovers.
  const trimmed = login && login.trim();
  if (trimmed) _selfLoginCache.set(host, trimmed);
  return trimmed || null;
}

// Test seam — reset the memoized logins between cases.
export function __resetSelfLoginCache() {
  _selfLoginCache.clear();
}

/**
 * Resolve a repo's default branch via gh. `repoSpec` is a host-qualified
 * `HOST/OWNER/REPO` selector (see checkPullRequests) — pinning the host makes
 * this work on GitHub Enterprise (a bare `OWNER/REPO` defaults to github.com)
 * while staying deterministic on a multi-remote (fork + upstream) checkout that
 * cwd-based auto-detection would resolve ambiguously. Returns null on failure.
 */
async function getDefaultBranch(repoSpec) {
  const name = await execGh(['repo', 'view', repoSpec, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])
    .catch(() => null);
  return name ? name.trim() : null;
}

/**
 * List open PRs targeting `baseBranch` for the host-qualified `repoSpec`
 * (`HOST/OWNER/REPO`). The host qualifier is what makes this enterprise-correct
 * and fork-safe — see getDefaultBranch. Returns an array of normalized PR
 * objects, or null on failure.
 */
async function listOpenPullRequests(repoSpec, baseBranch) {
  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec,
    '--base', baseBranch, '--state', 'open',
    '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,title,author,url,createdAt,isDraft,headRefName'
  ]).catch(() => null);
  if (raw === null) return null;
  // Guard the parse: a success-exit gh that emits empty/malformed stdout would
  // otherwise throw a SyntaxError, breaking this module's "never throws"
  // contract and aborting the scheduler tick (the generator calls
  // checkPullRequests with no try/catch). Degrade to the pr-list-failed path.
  const parsed = safeJSONParse(raw, null);
  if (parsed === null) return null;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((pr) => ({
    number: pr.number,
    title: pr.title || '',
    authorLogin: pr.author?.login || null,
    url: pr.url || '',
    createdAt: pr.createdAt || null,
    isDraft: pr.isDraft === true,
    headRefName: pr.headRefName || ''
  }));
}

/**
 * Does this PR match the author gate? Pure — exported for tests.
 *   'any'    → always
 *   'self'   → PR author === selfLogin
 *   'others' → PR author !== selfLogin (and author is known)
 */
export function matchesAuthorFilter(pr, authorFilter, selfLogin) {
  if (authorFilter === 'any') return true;
  const author = pr.authorLogin;
  if (authorFilter === 'self') return Boolean(author) && author === selfLogin;
  if (authorFilter === 'others') return Boolean(author) && author !== selfLogin;
  return true;
}

/**
 * Compute the new-PR set and the next high-water mark from a list of open PRs.
 * Pure — no I/O — so the dispatch decision is unit-testable without gh.
 *
 * @returns {{ firstRun: boolean, newPrs: object[], newLastSeen: number, candidateCount: number }}
 *   - firstRun: prevLastSeen was unset → baseline only, never dispatch.
 *   - newPrs: PRs above the mark that also pass the author gate.
 *   - newLastSeen: high-water mark to persist (max of prev mark and every open
 *     PR number we evaluated, so gated-out PRs don't get re-evaluated forever).
 *   - candidateCount: PRs above the mark before the author gate (for logging).
 */
export function computePrCheck({ prs, prevLastSeen, authorFilter, selfLogin }) {
  const maxOpen = prs.reduce((m, p) => Math.max(m, p.number), 0);

  if (prevLastSeen === null || prevLastSeen === undefined) {
    return { firstRun: true, newPrs: [], newLastSeen: maxOpen, candidateCount: 0 };
  }

  const candidates = prs.filter((p) => p.number > prevLastSeen);
  const newPrs = candidates.filter((p) => matchesAuthorFilter(p, authorFilter, selfLogin));
  // Advance past every open PR we've now evaluated — including gated-out ones —
  // so a fixed author gate doesn't re-surface the same PRs each tick.
  const newLastSeen = Math.max(prevLastSeen, maxOpen);
  return { firstRun: false, newPrs, newLastSeen, candidateCount: candidates.length };
}

/**
 * Read the persisted watcher state off an app record (tolerant of absence).
 */
export function readPrWatcherState(app) {
  const state = app?.prWatcherState;
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

/**
 * Merge a patch into the app's persisted watcher state. Re-reads the app first
 * so the merge is against the freshest record.
 */
export async function persistPrWatcherState(appId, patch) {
  const app = await getAppById(appId);
  if (!app) return null;
  const next = { ...readPrWatcherState(app), ...patch };
  return updateApp(appId, { prWatcherState: next });
}

/**
 * Check an app's GitHub repo for newly-opened PRs against its default branch.
 *
 * Never throws. Returns:
 *   { ok: false, reason }                              — nothing to do / config gap
 *   { ok: true, firstRun: true, repoFullName, defaultBranch, newLastSeen }
 *   { ok: true, newPrs, newLastSeen, repoFullName, defaultBranch, candidateCount }
 */
export async function checkPullRequests(app, { authorFilter = 'any' } = {}) {
  const filter = PR_AUTHOR_FILTERS.includes(authorFilter) ? authorFilter : 'any';

  const origin = await getOriginInfo(app.repoPath).catch(() => null);
  // Accept any GitHub-family host — github.com AND self-hosted GitHub Enterprise
  // (github.*) — not just github.com. `origin.isGithub` is github.com-only (it
  // drives PortOS's own fork/update flow), so gating on it silently excluded
  // enterprise repos. githubRepoSpec pairs the GitHub-host gate with the
  // host-qualified `HOST/OWNER/REPO` selector (null when not a resolvable GitHub
  // repo); gitlab.* and non-forge hosts fall through.
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) {
    return { ok: false, reason: 'not-a-github-repo' };
  }
  const repoFullName = origin.fullName;

  const defaultBranch = await getDefaultBranch(repoSpec);
  if (!defaultBranch) {
    return { ok: false, reason: 'default-branch-unresolved', repoFullName };
  }

  // Resolve self up front when the gate needs it — bail rather than firing
  // blindly if gh can't tell us who "self" is on THIS repo's host.
  let selfLogin = null;
  if (filter !== 'any') {
    // Canonicalize the host: an `ssh.github.com` alias origin must resolve "self"
    // against the github.com API host, matching githubRepoSpec's repo selector.
    // Passing origin.host raw would query the SSH endpoint and always return
    // self-login-unavailable, so self/others gates would never fire (#2650).
    selfLogin = await getSelfLogin(githubApiHost(origin.host));
    if (!selfLogin) {
      return { ok: false, reason: 'self-login-unavailable', repoFullName, defaultBranch };
    }
  }

  const prs = await listOpenPullRequests(repoSpec, defaultBranch);
  if (prs === null) {
    return { ok: false, reason: 'pr-list-failed', repoFullName, defaultBranch };
  }
  // Truncated page: gh returns newest-first, so advancing the high-water mark
  // to the page's max would mark the oldest unseen new PRs as seen without ever
  // dispatching them — and they'd never recover. Bail WITHOUT advancing the
  // mark instead; the next run retries, and once the open-PR count drops below
  // the cap the watcher resumes. No silent skip, no data loss. Realistically
  // unreachable for a single-user repo at a 200 cap.
  if (prs.length >= PR_LIST_LIMIT) {
    console.warn(`⚠️ pr-watcher: ${repoFullName} has ≥${PR_LIST_LIMIT} open PRs — deferring (not advancing the high-water mark) so no newly-opened PR is skipped.`);
    return { ok: false, reason: 'too-many-open-prs', repoFullName, defaultBranch };
  }

  const lastSeen = readPrWatcherState(app).lastSeenPrNumber;
  const prevLastSeen = Number.isInteger(lastSeen) ? lastSeen : null;

  const { firstRun, newPrs, newLastSeen, candidateCount } = computePrCheck({
    prs, prevLastSeen, authorFilter: filter, selfLogin
  });

  return { ok: true, firstRun, newPrs, newLastSeen, candidateCount, repoFullName, defaultBranch };
}

/**
 * Render the new-PR list into a Markdown block injected into the agent prompt
 * via the `{prData}` placeholder. Kept here (not in the template) so the format
 * can iterate without touching the prompt catalog.
 */
export function formatPullRequestsForPrompt(prs, { repoFullName, defaultBranch }) {
  const lines = [];
  lines.push(`Repo: ${repoFullName} — base branch: \`${defaultBranch}\``);
  lines.push('');
  for (const pr of prs) {
    const author = pr.authorLogin ? `by ${pr.authorLogin}` : 'by unknown author';
    const draft = pr.isDraft ? ' _(draft)_' : '';
    const when = pr.createdAt ? ` — opened ${pr.createdAt.slice(0, 10)}` : '';
    lines.push(`- **#${pr.number}** ${pr.title}${draft}`);
    lines.push(`  - ${author}${when} · head: \`${pr.headRefName}\``);
    if (pr.url) lines.push(`  - ${pr.url}`);
  }
  return lines.join('\n');
}
