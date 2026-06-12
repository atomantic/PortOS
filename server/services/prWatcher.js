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

// Cache the gh-authenticated login for the process lifetime. It's the PortOS
// operator's identity and effectively never changes within a run; re-resolving
// it on every scheduler tick would add a gh round-trip per watched app.
let _selfLoginCache;

/**
 * Resolve the gh-authenticated user's login (e.g. "atomantic"). Returns null
 * when gh isn't authenticated / installed — callers that need it for an
 * author gate must treat null as "can't gate, don't fire blindly".
 */
export async function getSelfLogin() {
  if (_selfLoginCache) return _selfLoginCache;
  const login = await execGh(['api', 'user', '--jq', '.login']).catch(() => null);
  // Only memoize a SUCCESSFUL lookup. Caching a null from a transient gh/auth
  // failure (keychain locked mid-tick, gh re-auth in progress) would wedge every
  // later self/others gate into 'self-login-unavailable' until process restart;
  // leaving the cache unset lets the next tick retry once auth recovers.
  const trimmed = login && login.trim();
  if (trimmed) _selfLoginCache = trimmed;
  return _selfLoginCache || null;
}

// Test seam — reset the memoized login between cases.
export function __resetSelfLoginCache() {
  _selfLoginCache = undefined;
}

/**
 * Resolve a repo's default branch via gh. Returns null on failure.
 */
async function getDefaultBranch(repoFullName) {
  const name = await execGh(['repo', 'view', repoFullName, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])
    .catch(() => null);
  return name ? name.trim() : null;
}

/**
 * List open PRs targeting `baseBranch` for `repoFullName`. Returns an array of
 * normalized PR objects, or null when the gh call fails.
 */
async function listOpenPullRequests(repoFullName, baseBranch) {
  const raw = await execGh([
    'pr', 'list', '--repo', repoFullName,
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
  if (!origin?.hasOrigin || !origin.isGithub || !origin.fullName) {
    return { ok: false, reason: 'not-a-github-repo' };
  }
  const repoFullName = origin.fullName;

  const defaultBranch = await getDefaultBranch(repoFullName);
  if (!defaultBranch) {
    return { ok: false, reason: 'default-branch-unresolved', repoFullName };
  }

  // Resolve self up front when the gate needs it — bail rather than firing
  // blindly if gh can't tell us who "self" is.
  let selfLogin = null;
  if (filter !== 'any') {
    selfLogin = await getSelfLogin();
    if (!selfLogin) {
      return { ok: false, reason: 'self-login-unavailable', repoFullName, defaultBranch };
    }
  }

  const prs = await listOpenPullRequests(repoFullName, defaultBranch);
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
