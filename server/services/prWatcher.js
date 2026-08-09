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

import { execGh, ensureForgeReachable } from './github.js';
import { getAppById, updateApp, getActiveApps } from './apps.js';
import * as git from './git.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';
import { classifyPrFailure } from './layeredIntelligenceRejections.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec, githubApiHost } from '../lib/workTracker.js';
import { PR_AUTHOR_FILTERS } from '../lib/validation.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { PR_COMPLETIONS } from '../lib/prDisposition.js';

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

// The pending-merge sweep runs on its own CoS timer (`cos-pending-merge-sweep`
// in cos.js) every 30 minutes. Six hours is long enough for an ordinary CI
// queue, while still surfacing a wedged provider or branch protection rule
// before a merge-only PR silently leaks forever. cos.js drives its interval off
// PENDING_MERGE_SWEEP_INTERVAL_MS so `MAX_PENDING_MERGE_TICKS` keeps mapping to
// wall-clock hours rather than to restarts (#3630).
export const PENDING_MERGE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
export const MAX_PENDING_MERGE_TICKS = 12;

const GREEN_CHECK_VERDICTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
// Every app lives in the same apps.json store, so this must be one global tail
// rather than a per-app map: simultaneous writes for different app ids would
// otherwise still load stale whole-file snapshots and clobber one another.
let pendingMergeWriteTail = Promise.resolve();

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
  const login = await execGh(['api', 'user', '--hostname', host, '--jq', '.login']).catch((err) => {
    // Log rather than swallow (#3358): without this a firewalled/unauthenticated
    // gh is indistinguishable from "this host has no login", and every self/others
    // gate silently stops firing with nothing in the log to explain it.
    console.error(`❌ pr-watcher: could not resolve the gh login on ${host}: ${err.message}`);
    return null;
  });
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
    .catch((err) => {
      console.error(`❌ pr-watcher: could not resolve the default branch for ${repoSpec}: ${err.message}`);
      return null;
    });
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
  ]).catch((err) => {
    console.error(`❌ pr-watcher: gh pr list failed for ${repoSpec}: ${err.message}`);
    return null;
  });
  if (raw === null) return null;
  // Guard the parse: a success-exit gh that emits empty/malformed stdout would
  // otherwise throw a SyntaxError, breaking this module's "never throws"
  // contract and aborting the scheduler tick (the generator calls
  // checkPullRequests with no try/catch). Degrade to the pr-list-failed path.
  // Anything that isn't an array is output we could not READ, not an empty
  // repo — degrading it to [] would clear the watcher's lastError and record a
  // quiet poll for a page we never parsed (#3358).
  const parsed = safeJSONParse(raw, null);
  if (!Array.isArray(parsed)) {
    console.error(`❌ pr-watcher: gh pr list returned unreadable output for ${repoSpec} — deferring this cycle`);
    return null;
  }
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
 * Read the merge-only PRs that a completed PortOS agent handed to this
 * watcher's deterministic CI gate. This lives beside, rather than inside,
 * `prWatcherState`: disabling the watcher clears its discovery high-water mark
 * so the next enable baselines cleanly, but it must never forget a PR it owns.
 */
export function readPendingMergePrs(app) {
  return Array.isArray(app?.pendingMergePrs) ? app.pendingMergePrs : [];
}

const pendingMergeKey = (pending) => `${pending?.prNumber ?? ''}:${pending?.prUrl ?? ''}`;

function normalizePendingMerge(pending) {
  if (!pending || typeof pending !== 'object') return null;
  if (!Number.isInteger(pending.prNumber) || pending.prNumber < 1) return null;
  if (typeof pending.prUrl !== 'string' || !pending.prUrl) return null;
  if (typeof pending.prBranch !== 'string' || !pending.prBranch) return null;
  if (!pending.sourceTask || typeof pending.sourceTask !== 'object') return null;
  return {
    ...pending,
    ticks: Number.isInteger(pending.ticks) && pending.ticks >= 0 ? pending.ticks : 0,
  };
}

function queuePendingMergeWrite(write) {
  const next = pendingMergeWriteTail.catch(() => undefined).then(write);
  pendingMergeWriteTail = next;
  return next;
}

async function mutatePendingMergePrs(appId, mutate) {
  return queuePendingMergeWrite(async () => {
    const app = await getAppById(appId);
    if (!app) return null;
    const next = mutate(readPendingMergePrs(app).map(normalizePendingMerge).filter(Boolean));
    return updateApp(appId, { pendingMergePrs: next });
  });
}

/**
 * Persist a merge-only PR for the next existing pr-watcher tick. The source
 * task carries only the fields the escalation path needs to recreate today's
 * merge follow-up, rather than retaining the whole completed task payload.
 */
export async function queuePendingMerge(appId, pending) {
  const normalized = normalizePendingMerge(pending);
  if (!appId || !normalized) return false;

  const result = await mutatePendingMergePrs(appId, (existing) => {
    const key = pendingMergeKey(normalized);
    const index = existing.findIndex((entry) => pendingMergeKey(entry) === key);
    if (index === -1) return [...existing, normalized];
    const next = [...existing];
    // Preserve the existing tick count so a duplicated completion callback
    // cannot reset an already-wedged PR's bounded-watch budget.
    next[index] = { ...normalized, ticks: existing[index].ticks };
    return next;
  });
  return Boolean(result);
}

/**
 * True only when an OPEN PR is cleanly mergeable and every reported check has
 * reached a non-blocking green verdict. An empty rollup remains pending: a
 * just-opened PR often reports no checks before CI attaches, and merging then
 * would race the gate this watcher is meant to enforce.
 */
export function isPendingMergeReady(prView) {
  if (String(prView?.state || '').toUpperCase() !== 'OPEN') return false;
  if (String(prView?.mergeStateStatus || '').toUpperCase() !== 'CLEAN') return false;
  const rollup = Array.isArray(prView?.statusCheckRollup) ? prView.statusCheckRollup : [];
  return rollup.length > 0 && rollup.every((check) => {
    const verdict = String(check?.conclusion || check?.state || '').toUpperCase();
    return GREEN_CHECK_VERDICTS.has(verdict);
  });
}

async function readPendingPullRequest(repoSpec, prNumber) {
  const raw = await execGh([
    'pr', 'view', String(prNumber), '--repo', repoSpec,
    '--json', 'state,mergeStateStatus,statusCheckRollup'
  ]).catch(() => null);
  const parsed = raw === null ? null : safeJSONParse(raw, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

async function notifyPendingMergeTimeout(app, pending, reason) {
  return addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    priority: PRIORITY_LEVELS.HIGH,
    title: `Merge-only PR #${pending.prNumber} needs attention`,
    description: `PortOS stopped polling this PR after ${MAX_PENDING_MERGE_TICKS} checks because ${reason}.`,
    link: pending.prUrl,
    metadata: { appId: app.id, pendingMergePrNumber: pending.prNumber }
  }).catch((err) => {
    console.error(`❌ Failed to notify about pending PR #${pending.prNumber}: ${err.message}`);
    return null;
  });
}

/**
 * Drive merge-only PortOS PRs on the normal pr-watcher cadence. Green PRs are
 * merged without consuming an agent lane; only a classified CI failure or
 * merge conflict recreates the pre-existing merge-only follow-up agent.
 */
export async function processPendingMergePrs(app) {
  const pending = readPendingMergePrs(app).map(normalizePendingMerge).filter(Boolean);
  if (pending.length === 0) return { ok: true, checked: 0, merged: 0, escalated: 0, timedOut: 0 };

  const origin = await getOriginInfo(app?.repoPath).catch(() => null);
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) return { ok: false, reason: 'not-a-github-repo' };

  // Skip rather than poll every pending PR into an `errors` count we can't act on.
  const forge = await ensureForgeReachable('pr-watcher pending-merge', { hostname: githubApiHost(origin.host) });
  if (!forge.ok) return { ok: false, reason: 'forge-unreachable', forgeStatus: forge.status };

  const outcomes = new Map();
  const result = { ok: true, checked: 0, merged: 0, escalated: 0, timedOut: 0, errors: 0 };

  for (const entry of pending) {
    const key = pendingMergeKey(entry);
    const prView = await readPendingPullRequest(repoSpec, entry.prNumber);
    if (!prView) {
      // An unreadable PR is still a cycle this entry spent pending, so it has to
      // tick. A PR whose `gh pr view` fails PERMANENTLY (deleted PR, renamed
      // repo, revoked token) would otherwise be re-queued unchanged forever:
      // MAX_PENDING_MERGE_TICKS never fires, the entry leaks in apps.json, and
      // we re-shell to `gh` on every cadence with nothing surfaced to the user.
      // `result.errors` accounting is unchanged — the cycle is both an error and
      // a tick.
      result.errors += 1;
      const unreadable = { ...entry, ticks: entry.ticks + 1 };
      if (unreadable.ticks >= MAX_PENDING_MERGE_TICKS) {
        await notifyPendingMergeTimeout(app, entry, 'it could not be read from the forge');
        outcomes.set(key, null);
        result.timedOut += 1;
      } else {
        outcomes.set(key, unreadable);
      }
      continue;
    }
    result.checked += 1;

    if (String(prView.state || '').toUpperCase() === 'MERGED') {
      outcomes.set(key, null);
      continue;
    }

    const failure = classifyPrFailure(prView);
    if (failure) {
      try {
        const { spawnReviewLoopFollowUp } = await import('./agentWorktreeCleanup.js');
        await spawnReviewLoopFollowUp({
          originalAgentId: entry.sourceAgentId || null,
          originalTask: entry.sourceTask,
          prUrl: entry.prUrl,
          prBranch: entry.prBranch,
          sourceWorkspace: app.repoPath,
          prCompletion: PR_COMPLETIONS.MERGE_ON_GREEN,
          reviewers: [],
          usernames: [],
          optionalReviewers: [],
          reviewerMaxRounds: {}
        });
        outcomes.set(key, null);
        result.escalated += 1;
      } catch (err) {
        console.error(`❌ Failed to escalate PR #${entry.prNumber}: ${err.message}`);
        outcomes.set(key, entry);
        result.errors += 1;
      }
      continue;
    }

    if (isPendingMergeReady(prView)) {
      const merge = await git.mergePR(app.repoPath, entry.prNumber).catch((err) => ({ success: false, error: err.message }));
      if (merge.success) {
        outcomes.set(key, null);
        result.merged += 1;
        continue;
      }
      console.error(`❌ Deterministic merge failed for PR #${entry.prNumber}: ${merge.error || 'unknown error'}`);
    }

    const next = { ...entry, ticks: entry.ticks + 1 };
    if (next.ticks >= MAX_PENDING_MERGE_TICKS) {
      const reason = String(prView.state || '').toUpperCase() !== 'OPEN'
        ? `it is ${String(prView.state).toLowerCase()} rather than open`
        : 'CI or mergeability did not settle';
      await notifyPendingMergeTimeout(app, entry, reason);
      outcomes.set(key, null);
      result.timedOut += 1;
    } else {
      outcomes.set(key, next);
    }
  }

  await mutatePendingMergePrs(app.id, (current) => current.flatMap((entry) => {
    const outcome = outcomes.get(pendingMergeKey(entry));
    return outcome === undefined ? [entry] : outcome ? [outcome] : [];
  }));
  return result;
}

/**
 * Drain every app's pending merge-only PRs, independent of whether that app has
 * the `pr-watcher` scheduled task enabled.
 *
 * `queuePendingMerge` is written from the agent-completion path whenever a
 * merge-on-green PR is opened — a path with no relationship to the watcher's
 * task-type config. Draining it only from `resolvePrWatcherBlock` (which runs
 * exclusively when a `pr-watcher` task fires) meant that on the common setup —
 * `pr-watcher` left disabled, since its default prompt is a review-and-comment
 * agent most operators don't want — PortOS queued PRs into a list nothing ever
 * read. Green PRs then sat open forever at `ticks: 0`, and even the bounded
 * `MAX_PENDING_MERGE_TICKS` escape hatch never fired.
 *
 * Called from the CoS evaluation tick, which is the same cadence-bearing loop
 * that spawned the agent that opened the PR. Never throws: each app is swept
 * independently and a failure is returned in `failures`, so one unreachable
 * forge can't stall the tick.
 *
 * @returns {Promise<{checked: number, merged: number, escalated: number,
 *   timedOut: number, failures: number}>}
 */
export async function sweepPendingMergePrs() {
  const totals = { checked: 0, merged: 0, escalated: 0, timedOut: 0, failures: 0 };
  const apps = await getActiveApps().catch(() => []);
  // Only apps that actually own a queued PR — the common case is an empty list,
  // and `processPendingMergePrs` short-circuits on it anyway, but filtering here
  // keeps the tick from resolving git origins for every managed app.
  const withPending = apps.filter((app) => readPendingMergePrs(app).length > 0);
  for (const app of withPending) {
    const result = await processPendingMergePrs(app).catch((err) => ({ ok: false, reason: err.message }));
    if (!result?.ok) {
      totals.failures += 1;
      console.log(`⚠️ Pending-merge sweep failed for ${app.name}: ${result?.reason || 'unknown error'}`);
      continue;
    }
    totals.checked += result.checked || 0;
    totals.merged += result.merged || 0;
    totals.escalated += result.escalated || 0;
    totals.timedOut += result.timedOut || 0;
  }
  return totals;
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

  // Probe before any gh read (#3358). Without this an unreachable gh returns an
  // empty PR page, the high-water mark stays put, and the watcher reports a
  // quiet repo forever with nothing in the log naming the real cause. Probed
  // against THIS repo's API host, not gh's default — an enterprise app must not
  // be gated on github.com's health (and vice versa).
  const forge = await ensureForgeReachable('pr-watcher', { hostname: githubApiHost(origin.host) });
  if (!forge.ok) return { ok: false, reason: 'forge-unreachable', forgeStatus: forge.status, repoFullName };

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
