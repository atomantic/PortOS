/**
 * Perpetual Work Detectors
 *
 * Programmatic (no-LLM) "is there actionable work?" probes for perpetual
 * scheduled tasks (INTERVAL_TYPES.PERPETUAL in taskSchedule.js). A perpetual
 * task drains work back-to-back until its detector reports nothing actionable,
 * then PARKS on a recheck cadence (see taskSchedule.parkPerpetual). The detector
 * IS the "pre-run check": it must mirror the corresponding claim prompt's
 * skip-list so the drain converges to the SAME empty state the agent would
 * reach — otherwise the drain re-picks an issue the agent always skips and never
 * parks.
 *
 * The registry is pluggable: `detectActionableWork(taskType, app, opts)`
 * dispatches on the RESOLVED prompt task type (claim-issue, plan-task, …). A
 * task type with no registered detector returns `{ actionable: false,
 * reason: 'no-detector' }` so perpetual mode PARKS rather than drains blindly.
 *
 * Detector results carry a `transient` flag: a definitive "no work" (empty
 * actionable set) parks; a transient probe failure (gh unauthenticated, list
 * errored) is surfaced with `transient: true` so the caller skips THIS dispatch
 * without parking — the next evaluation tick retries instead of waiting out a
 * full recheck cadence on a blip.
 */

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { emitLog } from './cosEvents.js';
import { parsePlanItems, extractAllIds, findInProgressIds, pickFirstAvailable, extractSlugFromRef } from '../lib/planIds.js';
import { readOriginRemoteUrl } from '../lib/gitRemote.js';

// Labels that make a GitHub issue non-actionable for autonomous claiming. MUST
// stay in sync with the claim-issue prompt's Phase 1 skip-list
// (server/services/taskPromptDefaults/prompts.js). `needs-input` is the park
// label the agent applies when it decides an issue needs a human decision
// (claim-issue prompt Phase 3) — excluding it here is what lets a perpetual
// drain converge instead of re-picking the same ambiguous issue forever.
export const NON_ACTIONABLE_ISSUE_LABELS = new Set([
  'in-progress', 'blocked', 'needs-input', 'future', 'wontfix', 'question', 'discussion'
]);

const CLI_TIMEOUT_MS = 15000;

/**
 * Best-effort CLI runner mirroring git.js#spawnCli (which isn't exported).
 * Never rejects: a spawn error, non-zero exit, or timeout all resolve to a
 * result object the detectors classify themselves.
 */
function runCli(cmd, args, cwd) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => done({ code: -1, stdout: '', stderr: '' }));
    child.on('close', (code) => done({ code, stdout, stderr }));
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } done({ code: -1, stdout: '', stderr: '' }); }, CLI_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
}

/**
 * Extract a GitHub issue number from a git ref ONLY when it matches a documented
 * claim pattern (`claim/issue-<num>` or `cos/<task>/issue-<num>/<agent>`).
 * Reuses extractSlugFromRef so the ref-matching rules stay in one place.
 */
export function issueNumberFromRef(ref) {
  const slug = extractSlugFromRef(ref);
  if (!slug) return null;
  const m = /^issue-(\d+)$/.exec(slug);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve the FULL GitLab project namespace (every path segment before the final
 * repo segment) from the git origin remote — INCLUDING nested subgroups. The
 * shared `parseGitRemoteUrl` only accepts a two-segment `owner/repo`, so a
 * subgroup-nested project (`parent/subgroup/project`) resolves to null there and
 * never reaches the group probe below; parse the raw path here so nested subgroups
 * get the same owner-is-group short-circuit as a top-level group. GitLab subgroups
 * are the common layout, so this is the difference between the short-circuit
 * working and silently never firing for real GitLab projects. Returns null when
 * there's no origin remote or the URL has no namespace segment (a bare `repo`).
 * For a single-owner remote (`alice/repo`) this returns just `alice`, so the
 * user-namespace `--author` path keeps its old value.
 */
async function resolveGitlabNamespace(repoPath) {
  const url = await readOriginRemoteUrl(repoPath).catch(() => null);
  if (typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim().replace(/\.git$/i, '');
  // Extract the repo PATH (everything after the host) without mistaking any of the
  // host for it. A `[^/]+` host run stops at the path's first slash — and since a
  // host (bracketed IPv6 included) contains no slash, this isolates the path even
  // for `[2001:db8::1]/group/repo` and keeps a `:port` with the host. No numeric
  // segment is ever stripped from the path, so a numeric GitLab namespace
  // (`/1234/repo`) survives intact.
  let rawPath = null;
  const urlStyle = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/);
  if (urlStyle) {
    rawPath = urlStyle[1]; // scheme://[user@]host[:port]/PATH
  } else {
    // scp-style SSH: [user@]host:PATH — the host may be a bracketed IPv6 literal
    // (whose inner colons must NOT be read as the host/path separator).
    const scpStyle = trimmed.match(/^(?:[^@]+@)?(?:\[[^\]]+\]|[^:]+):(.+)$/);
    if (!scpStyle) return null;
    rawPath = scpStyle[1];
  }
  const segments = rawPath.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segments.length < 2) return null; // need at least namespace + repo
  segments.pop(); // drop the repo segment; the rest is the (possibly nested) namespace
  return segments.join('/');
}

/**
 * Collect the set of issue numbers currently in flight, evidenced by an open
 * `claim/issue-<num>` / `cos/.../issue-<num>/...` branch (local or remote) or an
 * open PR/MR source ref. Best-effort — degrades to whatever evidence is reachable.
 * `forge` selects how open changes are listed: GitHub PR head refs
 * (`gh pr list`) vs GitLab MR source branches (`glab mr list`).
 */
async function inFlightIssueNumbers(repoPath, forge = 'github') {
  const nums = new Set();
  // The branch list and the PR/MR list are independent CLI calls — run concurrently.
  const prListCall = forge === 'gitlab'
    ? runCli('glab', ['mr', 'list', '--per-page', '100', '-F', 'json'], repoPath)
    : runCli('gh', ['pr', 'list', '--state', 'open', '--json', 'headRefName', '-q', '.[].headRefName'], repoPath);
  const [branchRes, prRes] = await Promise.all([
    runCli('git', ['branch', '-a', '--no-color', '--format=%(refname:short)'], repoPath),
    prListCall
  ]);
  const refs = (branchRes.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (forge === 'gitlab') {
    // glab returns MR objects as JSON; the in-flight ref is each MR's source_branch.
    let mrs = [];
    try { mrs = JSON.parse(prRes.stdout || '[]'); } catch { mrs = []; }
    if (Array.isArray(mrs)) {
      for (const mr of mrs) {
        if (mr?.source_branch) refs.push(String(mr.source_branch).trim());
      }
    }
  } else {
    refs.push(...(prRes.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
  }
  for (const ref of refs) {
    const n = issueNumberFromRef(ref);
    if (n != null) nums.add(n);
  }
  return nums;
}

/**
 * Recognize a tracking/umbrella EPIC from its title alone — the programmatic
 * half of the claim-issue prompt's Phase 1 epic skip. An epic needs a human to
 * split it per-slice, so the claim agent always skips one; the detector MUST
 * skip it too or a perpetual drain re-picks it every tick and never parks.
 * Matches the epic-title conventions the prompt names and the agent honors:
 *   - a trailing `(epic)` tag  — e.g. "Redesign nav (epic)"
 *   - a leading `[epic]` bracket or `Epic:` colon tag — e.g. "[Epic] Billing
 *     revamp", "[epic: theme] …", "Epic: Redesign nav" (case-insensitive)
 * The leading-tag branch is what closes the real-world non-convergence bug: an
 * epic titled "[Epic] …" that carries NO `epic` label kept reading as actionable
 * (label check missed it, and it doesn't END in "(epic)"), so the drain spawned
 * a claim agent that correctly skipped it, completed with nothing shipped, and
 * re-fired back-to-back. The `\b` + `[:\]]` terminator keeps a bare adjective
 * ("Epic rework of nav") and near-words ("[epicenter] …") from matching — only a
 * real bracketed/colon-delimited `epic` tag counts.
 */
export function titleMarksEpic(title) {
  const t = (title || '').trim().toLowerCase();
  return t.endsWith('(epic)') || /^\[?\s*epic\b\s*[:\]]/.test(t);
}

/**
 * Decide whether a single GitHub issue (as returned by `gh issue list --json`)
 * is autonomously claimable. Mirrors the claim-issue prompt's Phase 1 step 4
 * predicate: no in-flight claim ref, no assignees, no blocking label, not an
 * epic. Exported for direct unit testing.
 */
export function isActionableIssue(issue, inFlight = new Set()) {
  if (!issue || typeof issue.number !== 'number') return false;
  if (inFlight.has(issue.number)) return false;
  if (Array.isArray(issue.assignees) && issue.assignees.length > 0) return false;
  const labels = (Array.isArray(issue.labels) ? issue.labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name) || '')
    .map((s) => s.toLowerCase());
  if (labels.some((l) => NON_ACTIONABLE_ISSUE_LABELS.has(l))) return false;
  if (labels.includes('epic')) return false;
  if (titleMarksEpic(issue.title)) return false;
  return true;
}

// Per-forge config for the shared issue detector. Each entry captures only what
// differs between GitHub (`gh`) and GitLab (`glab`): the CLI + issue-list args,
// how owner-mode resolves the author filter, the transient reason strings, and
// how a raw issue maps to the forge-agnostic `{ number, title, labels, assignees }`
// shape `isActionableIssue` expects. The control flow itself lives once in
// `detectForgeIssues`. `inFlightForge` selects the in-flight scan dialect.
const FORGE_ISSUE_CONFIG = {
  'claim-issue': {
    cli: 'gh',
    inFlightForge: 'github',
    listArgs: ['issue', 'list', '--state', 'open', '--search', 'sort:created-asc', '--json', 'number,assignees,labels,title', '--limit', '100'],
    listFail: 'gh-list-failed',
    parseFail: 'gh-parse-failed',
    // Park reason when the owner filter resolves to a non-authoring owner. On
    // GitHub that owner is an ORG; the toast copy is org-flavored to match.
    ownerIsOrgReason: 'owner-is-org',
    // Authoritative repo owner (org or user) + whether that owner is an org, via
    // gh; transient if gh is unauthenticated / not a GitHub remote. `isOrg` lets
    // detectForgeIssues short-circuit the owner-filter org trap — an org login is
    // never an issue author, so `--author <org>` is guaranteed to match nothing.
    resolveOwner: async (repoPath) => {
      const r = await runCli('gh', ['repo', 'view', '--json', 'owner,isInOrganization'], repoPath);
      if (r.code !== 0) return { error: 'gh-unavailable' };
      let parsed;
      try {
        parsed = JSON.parse(r.stdout || '{}');
      } catch {
        return { error: 'gh-unavailable' };
      }
      const owner = (parsed?.owner?.login || '').trim();
      if (!owner) return { error: 'gh-unavailable' };
      return { owner, isOrg: parsed?.isInOrganization === true };
    },
    // `--self` mode: gh natively understands the `@me` token for `--author`, so
    // no extra lookup is needed — the API resolves it to the authenticated user.
    resolveSelf: async () => ({ author: '@me' }),
    normalize: (raw) => raw
  },
  'claim-issue-gitlab': {
    cli: 'glab',
    inFlightForge: 'gitlab',
    listArgs: ['issue', 'list', '--per-page', '100', '-F', 'json'],
    listFail: 'glab-list-failed',
    parseFail: 'glab-parse-failed',
    // Park reason when the owner filter resolves to a non-authoring owner. On
    // GitLab that owner is a GROUP, not an "org"; the toast copy is group-flavored
    // to match (a GitLab user would never call their namespace an org).
    ownerIsOrgReason: 'owner-is-group',
    // GitLab has no authoritative `gh repo view` equivalent here; resolve the
    // author filter from the project namespace (git remote owner), matching the
    // claim-issue-gitlab prompt. GitLab can't tell a user namespace from a GROUP
    // (or nested subgroup) from the remote URL alone, so probe:
    // `glab api groups/<url-encoded-namespace>` returns 200 for a group/subgroup
    // and 404 for a user namespace. A group is never an issue author, so populate
    // `isOrg: true` for groups and let detectForgeIssues fire the same owner-filter
    // short-circuit GitHub uses — no new branch logic. The namespace is URL-encoded
    // so a nested subgroup path (`parent/subgroup`) hits the group endpoint as
    // `groups/parent%2Fsubgroup`. A probe failure (network/unauth/non-200) degrades
    // to isOrg:false → the pre-existing `--author <owner>` behavior, so no new
    // transient park appears.
    //
    // Numeric-namespace guard: `groups/:id` treats an ALL-NUMERIC `:id` as a
    // database group ID, not a path — so probing `groups/1234` could match an
    // unrelated group by ID and falsely park a user's `/1234/widget` as
    // owner-is-group. GitLab forbids all-numeric namespace *paths* precisely to
    // avoid this id/path ambiguity, so such a namespace shouldn't occur; if one
    // somehow does, skip the ambiguous probe and take the safe `--author <ns>`
    // path (isOrg:false). Nested subgroups are URL-encoded (`parent%2Fsub`) and so
    // are never all-numeric — they still probe normally.
    resolveOwner: async (repoPath) => {
      const namespace = await resolveGitlabNamespace(repoPath);
      if (!namespace) return { error: 'glab-owner-unresolved' };
      const probe = /^\d+$/.test(namespace)
        ? { code: 1 }
        : await runCli('glab', ['api', `groups/${encodeURIComponent(namespace)}`], repoPath);
      return { owner: namespace, isOrg: probe.code === 0 };
    },
    // `--self` mode: glab's `--author` expects a username (no `@me` token), so
    // resolve the authenticated account via the API; transient if glab is
    // unauthenticated / unreachable.
    resolveSelf: async (repoPath) => {
      const r = await runCli('glab', ['api', 'user', '-q', '.username'], repoPath);
      const author = (r.stdout || '').trim();
      return (r.code !== 0 || !author) ? { error: 'glab-unavailable' } : { author };
    },
    // GitLab keys the number on `iid` and returns labels as plain strings.
    normalize: (raw) => raw.map((r) => ({ number: r.iid, title: r.title, labels: r.labels, assignees: r.assignees }))
  }
};

/**
 * Best-effort count of ALL open issues in a repo, ignoring the author filter.
 * Used to disambiguate an empty *author-filtered* list: a repo whose only open
 * issues were filed by someone else must not be reported as "no open issues".
 * Any probe failure (list error / bad JSON / non-array) returns 0 so the caller
 * falls back to the definitive `no-open-issues` result rather than inventing a
 * phantom count. Reuses `cfg.listArgs`, which is the base list WITHOUT the
 * `--author` filter (the filter is appended separately in detectForgeIssues).
 */
async function countOpenIssuesUnfiltered(cfg, repoPath) {
  const res = await runCli(cfg.cli, [...cfg.listArgs], repoPath);
  if (res.code !== 0) return 0;
  let raw;
  try {
    raw = JSON.parse(res.stdout || '[]');
  } catch {
    return 0;
  }
  return Array.isArray(raw) ? raw.length : 0;
}

/**
 * Shared claim-issue detector for both forges (config in FORGE_ISSUE_CONFIG).
 * Counts open issues that pass the same skip-list the claim agent applies,
 * honoring the author filter ('self' = only issues YOU filed (`@me`), the
 * default and the slashdo `/do:next --self` security boundary; 'owner' = only
 * the repo owner's issues; 'any' = every author). The in-flight scan runs only
 * when the list is non-empty, so an empty queue parks without a wasted
 * branch/PR scan.
 */
async function detectForgeIssues(forgeKey, app, { issueAuthorFilter = 'self' } = {}) {
  const cfg = FORGE_ISSUE_CONFIG[forgeKey];
  const repoPath = app?.repoPath;
  if (!repoPath) return { actionable: false, count: 0, reason: 'no-repo-path' };

  // Shared shape for a "parked" (no actionable work) result where only `reason`
  // and `total` (the open-issue denominator) vary. `count`/`inFlightCount`/
  // `filteredCount` are always 0 on these paths — the issues are excluded
  // upstream (author filter / empty repo), never by the skip-list — so the toast
  // reads a clean "0 of N open" with no redundant "N filtered".
  const parked = (reason, total = 0) => ({
    actionable: false, count: 0, total, inFlightCount: 0, filteredCount: 0, reason
  });

  const args = [...cfg.listArgs];
  // Resolve the author filter symmetrically with resolveIssueAuthorFilterBlock:
  // 'any' = no filter; 'owner' = repo/project owner; everything else (the 'self'
  // default plus any out-of-vocab value) = the @me security boundary. Transient
  // resolver failures skip this dispatch and retry next tick rather than parking
  // a full cadence.
  let authorApplied = false;
  if (issueAuthorFilter === 'any') {
    // no --author filter
  } else if (issueAuthorFilter === 'owner') {
    const { owner, isOrg, error } = await cfg.resolveOwner(repoPath);
    if (error) return { actionable: false, count: 0, reason: error, transient: true };
    if (isOrg) {
      // The owner filter resolved to a non-authoring owner (a GitHub ORG or a
      // GitLab GROUP), which can never be an issue author — `--author <owner>` is
      // guaranteed to match zero. Skip that empty query and report the real open
      // count with the forge-flavored short-circuit reason (`owner-is-org` /
      // `owner-is-group`), so the toast steers the user to 'self'/'any' instead of
      // implying a personal-username mismatch (the failure that motivated this).
      const openCount = await countOpenIssuesUnfiltered(cfg, repoPath);
      return parked(cfg.ownerIsOrgReason, openCount);
    }
    args.push('--author', owner);
    authorApplied = true;
  } else {
    const { author, error } = await cfg.resolveSelf(repoPath);
    if (error) return { actionable: false, count: 0, reason: error, transient: true };
    args.push('--author', author);
    authorApplied = true;
  }

  const res = await runCli(cfg.cli, args, repoPath);
  if (res.code !== 0) return { actionable: false, count: 0, reason: cfg.listFail, transient: true };
  let raw;
  try {
    raw = JSON.parse(res.stdout || '[]');
  } catch {
    return { actionable: false, count: 0, reason: cfg.parseFail, transient: true };
  }
  if (!Array.isArray(raw)) return { actionable: false, count: 0, reason: cfg.parseFail, transient: true };
  if (raw.length === 0) {
    // An empty *filtered* list is ambiguous: the repo may truly have no open
    // issues, OR it has open issues that just don't match the author filter —
    // e.g. `self`/@me resolving to a different identity than whoever filed the
    // issues, or a non-org `owner` who simply filed none. (The org/group-owner
    // trap is caught earlier with the distinct `owner-is-org`/`owner-is-group`
    // reason.)
    // Reporting a flat "no open issues" there hid a claimable queue behind a
    // full recheck park (the "open issues exist but the task still parked"
    // failure this fixes). Re-probe WITHOUT the author filter; if issues exist,
    // park with the actionable `no-authored-issues` reason + the real open
    // count so the user is told to widen the filter, not that there is nothing
    // to do. The count is raw open issues (any author), not claimable ones —
    // best effort: switching to `any` may still yield `no-actionable-issues`
    // when the other-authored issues are all blocked/assigned/epics. Counting
    // claimable ones would cost the full normalize + skip-list scan here.
    if (authorApplied) {
      const openCount = await countOpenIssuesUnfiltered(cfg, repoPath);
      if (openCount > 0) return parked('no-authored-issues', openCount);
    }
    return parked('no-open-issues');
  }

  const inFlight = await inFlightIssueNumbers(repoPath, cfg.inFlightForge);
  const issues = cfg.normalize(raw);
  const total = issues.length;
  // How many of the OPEN issues were skipped only because a claim/PR is already
  // in flight for them (stale post-merge branches count here). Surfacing this
  // separately from the label/assignee/epic filter tells the user WHY an
  // apparently-non-empty queue yields zero claimable work — the exact confusion
  // behind "40 open issues but it parked."
  const inFlightCount = issues.filter((i) => typeof i.number === 'number' && inFlight.has(i.number)).length;
  const actionable = issues.filter((issue) => isActionableIssue(issue, inFlight));
  const filteredCount = Math.max(0, total - actionable.length - inFlightCount);
  return {
    actionable: actionable.length > 0,
    count: actionable.length,
    total,
    inFlightCount,
    filteredCount,
    reason: actionable.length > 0 ? 'actionable-issues' : 'no-actionable-issues',
    sample: actionable.slice(0, 5).map((i) => i.number)
  };
}

// Forge-specific detector entry points (thin wrappers over the shared factory).
export const detectGithubIssues = (app, opts) => detectForgeIssues('claim-issue', app, opts);
export const detectGitlabIssues = (app, opts) => detectForgeIssues('claim-issue-gitlab', app, opts);

/**
 * plan-task detector. Mirrors applyPlanIdMetadata's pick gate: an item is
 * actionable when it is unchecked, not blocked on human input (NEEDS_INPUT),
 * not drift-flagged, carries an id, and isn't already in flight via a
 * `claim/<slug>` branch/PR.
 */
export async function detectPlanTask(app) {
  const repoPath = app?.repoPath;
  if (!repoPath) return { actionable: false, count: 0, reason: 'no-repo-path' };
  const planMd = await readFile(join(repoPath, 'PLAN.md'), 'utf-8').catch(() => '');
  if (!planMd) return { actionable: false, count: 0, reason: 'no-plan' };

  const items = parsePlanItems(planMd);
  const knownIds = new Set(extractAllIds(planMd));
  const inFlight = await findInProgressIds(repoPath, knownIds).catch(() => new Set());
  const pick = pickFirstAvailable(items, inFlight);
  const count = items.filter((it) =>
    !it.checked && !it.needsInput && !it.drifted && it.id && !inFlight.has(it.id)
  ).length;
  return {
    actionable: !!pick,
    count,
    reason: pick ? 'actionable-plan-items' : 'no-actionable-plan-items'
  };
}

// ============================================================
// Registry
// ============================================================

const DETECTORS = new Map();

export function registerWorkDetector(taskType, fn) {
  DETECTORS.set(taskType, fn);
}

export function getWorkDetector(taskType) {
  return DETECTORS.get(taskType) || null;
}

export function hasWorkDetector(taskType) {
  return DETECTORS.has(taskType);
}

// Built-in detectors. claim-work resolves to one of these RESOLVED prompt task
// types before dispatch, so claim-work itself needs no detector. The JIRA claim
// flow (claim-issue-jira) has no detector yet — perpetual mode on a JIRA-tracked
// app parks with reason 'no-detector' until one is registered.
registerWorkDetector('claim-issue', detectGithubIssues);
registerWorkDetector('claim-issue-gitlab', detectGitlabIssues);
registerWorkDetector('plan-task', detectPlanTask);

/**
 * Probe whether `taskType` has actionable work for `app`. Always resolves to a
 * normalized shape: `{ actionable, count, reason, transient?, hasDetector }`.
 * A detector throw is caught and reported as a transient failure so the caller
 * skips (and retries) rather than parking on a broken probe.
 */
export async function detectActionableWork(taskType, app, opts = {}) {
  const detector = DETECTORS.get(taskType);
  if (!detector) {
    return { actionable: false, count: 0, reason: 'no-detector', hasDetector: false };
  }
  const result = await detector(app, opts).catch((err) => {
    emitLog('warn', `Perpetual work-detector for ${taskType} errored: ${err.message}`, { taskType, appId: app?.id }, '🔁 Perpetual');
    return { actionable: false, count: 0, reason: `detector-error: ${err.message}`, transient: true };
  });
  // Every detector (and the catch above) returns `count`, so spread last.
  return { ...result, hasDetector: true };
}
