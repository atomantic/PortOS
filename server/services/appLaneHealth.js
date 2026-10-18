/**
 * Lane health for an app's audit lanes (#12088): the forge and git reads behind
 * `lib/laneHealth.js`. One read per source; the `lane-health` task data input
 * narrows the issue read to the running lane's metric label, the Quality page
 * reads every lane at once.
 */

import { execGit } from '../lib/execGit.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { normalizeAuditTaskType } from '../lib/auditCatalog.js';
import { auditLanes, computeLaneHealth, LANE_HEALTH_WINDOW_DAYS, LANE_REFILE_WINDOW_DAYS } from '../lib/laneHealth.js';
import { resolveAppWorkTracker } from '../lib/workTracker.js';
import { resolveForgeTokenEnv } from './forgeAuth.js';
import { describeForgeReadFailure, resolveForgeContext, runForgeCli } from './taskDataInputs.js';

const DAY_MS = 86_400_000;
// Every lane of a busy install files thousands of issues in a window; the page
// read stops here and reports the window it actually covered.
const ALL_LANES_ISSUE_LIMIT = 1000;
const ONE_LANE_ISSUE_LIMIT = 500;
const PULL_REQUEST_LIMIT = 300;
const GIT_TIMEOUT_MS = 15_000;
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;

const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);
const labelNames = (labels) => (Array.isArray(labels) ? labels : [])
  .map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
const closingIssueNumbers = (text) => [...String(text || '').matchAll(CLOSING_KEYWORD)].map((match) => Number(match[1]));

function normalizeIssue(cli, item) {
  if (cli === 'glab') {
    return {
      number: item.iid, title: item.title || '', labels: labelNames(item.labels),
      createdAt: item.created_at || null, closedAt: item.closed_at || null,
      state: String(item.state || '').toLowerCase() === 'opened' ? 'open' : String(item.state || '').toLowerCase(),
      // GitLab has no close reason; a closed issue reads as completed.
      stateReason: null, body: item.description || '', url: item.web_url || null, linkedPullRequests: [],
    };
  }
  return {
    number: item.number, title: item.title || '', labels: labelNames(item.labels),
    createdAt: item.createdAt || null, closedAt: item.closedAt || null,
    state: String(item.state || '').toLowerCase(), stateReason: item.stateReason || null,
    body: item.body || '', url: item.url || null,
    linkedPullRequests: (item.closedByPullRequestsReferences || []).map((ref) => ref?.number).filter((n) => n != null),
  };
}

function normalizePullRequest(cli, item) {
  if (cli === 'glab') {
    return {
      number: item.iid, mergeCommit: item.merge_commit_sha || null,
      commitShas: [item.sha].filter(Boolean), closesIssues: closingIssueNumbers(item.description),
    };
  }
  return {
    number: item.number, mergeCommit: item.mergeCommit?.oid || null,
    // Only the oids: the commits payload also carries author identities.
    commitShas: (item.commits || []).map((commit) => commit?.oid).filter(Boolean),
    closesIssues: [
      ...(item.closingIssuesReferences || []).map((ref) => ref?.number).filter((n) => n != null),
      ...closingIssueNumbers(item.body),
    ],
  };
}

function parseRows(cli, result) {
  if (result.code !== 0 || !result.stdout.trim()) return { ok: false, error: result.code !== 0 ? (result.stderr || '') : `${cli} returned no parseable list` };
  const parsed = safeJSONParse(result.stdout, null, { logError: false });
  return Array.isArray(parsed) ? { ok: true, rows: parsed } : { ok: false, error: `${cli} returned no parseable list` };
}

/** Issues created since `since` (epoch ms), newest first; `label` narrows to one lane. */
async function listForgeIssuesSince({ cli, cwd, env, since, label = null, limit = ALL_LANES_ISSUE_LIMIT, exec = runForgeCli } = {}) {
  if (!cwd || (cli !== 'gh' && cli !== 'glab')) return { ok: false, issues: [], truncated: false };
  const args = cli === 'glab'
    ? ['issue', 'list', '--all', '-P', String(limit), ...(label ? ['--label', label] : [])]
    : [
        'issue', 'list', '--state', 'all', '--limit', String(limit),
        '--search', `created:>=${dateOnly(since)} sort:created-desc`,
        ...(label ? ['--label', label] : []),
        '--json', 'number,title,labels,createdAt,closedAt,state,stateReason,body,url,closedByPullRequestsReferences',
      ];
  const parsed = parseRows(cli, await exec(cli, args, { cwd, env }));
  if (!parsed.ok) return { ok: false, issues: [], truncated: false, error: parsed.error };
  const issues = parsed.rows.map((item) => normalizeIssue(cli, item))
    .filter((issue) => !Number.isFinite(Date.parse(issue.createdAt)) || Date.parse(issue.createdAt) >= since);
  return { ok: true, issues, truncated: parsed.rows.length >= limit };
}

/** Pull/merge requests merged since `since`, with the SHAs a revert could name. */
async function listForgeMergedPullRequestsSince({ cli, cwd, env, since, limit = PULL_REQUEST_LIMIT, exec = runForgeCli } = {}) {
  if (!cwd || (cli !== 'gh' && cli !== 'glab')) return { ok: false, items: [] };
  const args = cli === 'glab'
    ? ['mr', 'list', '--merged', '-P', String(limit)]
    : [
        'pr', 'list', '--state', 'merged', '--limit', String(limit),
        '--search', `merged:>=${dateOnly(since)} sort:updated-desc`,
        '--json', 'number,mergeCommit,commits,closingIssuesReferences,body',
      ];
  const parsed = parseRows(cli, await exec(cli, args, { cwd, env }));
  if (!parsed.ok) return { ok: false, items: [], error: parsed.error };
  return { ok: true, items: parsed.rows.map((item) => normalizePullRequest(cli, item)) };
}

/**
 * Commits since `since` whose message has a line starting with "Revert" — a
 * cheap prefilter; `computeLaneHealth` re-checks the subject. `null` when git fails,
 * so a broken checkout is not read as "nothing was reverted".
 */
async function listRevertCommitsSince(repoPath, since, { runGit = execGit } = {}) {
  if (!repoPath) return null;
  const result = await runGit(
    ['log', `--since=${new Date(since).toISOString()}`, '-i', '--grep=^revert', '--format=%H%x1f%s%x1f%b%x1e', 'HEAD'],
    repoPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return result.stdout.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, subject = '', body = ''] = record.split('\x1f');
    return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
  });
}

/**
 * @param {object} app - managed app (`repoPath`)
 * @param {object} options
 * @param {object|null} options.forge - resolved `{ cli, env, host }` (see `resolveForgeContext`)
 * @param {string|null} [options.taskType] - one audit lane; omitted reads every lane
 * @returns {Promise<object>} `{ ok: false, reason, error? }` or the `computeLaneHealth` report
 *   plus `ok: true`, `truncated` and `partial` (sources whose read failed).
 */
export async function collectLaneHealth(app, { forge, taskType = null, now = Date.now(), deps = {} } = {}) {
  if (!forge || !app?.repoPath) return { ok: false, reason: 'forge-unavailable' };
  const lanes = auditLanes();
  const lane = taskType ? lanes.find((candidate) => candidate.id === normalizeAuditTaskType(taskType)) : null;
  if (taskType && !lane) return { ok: false, reason: 'not-an-audit-lane' };
  const windowDays = LANE_HEALTH_WINDOW_DAYS;
  const refileDays = LANE_REFILE_WINDOW_DAYS;
  const from = now - windowDays * DAY_MS;
  const forgeOptions = { cli: forge.cli, cwd: app.repoPath, env: forge.env };
  // `deps.exec` / `deps.runGit` replace the forge CLI and git spawns.
  const exec = deps.exec || runForgeCli;
  const [issues, pullRequests, commits] = await Promise.all([
    listForgeIssuesSince({ ...forgeOptions, since: from - refileDays * DAY_MS, label: lane?.metricLabel ?? null, limit: lane ? ONE_LANE_ISSUE_LIMIT : ALL_LANES_ISSUE_LIMIT, exec }),
    listForgeMergedPullRequestsSince({ ...forgeOptions, since: from, exec }),
    listRevertCommitsSince(app.repoPath, from, { runGit: deps.runGit || execGit }),
  ]);
  if (!issues.ok) return { ok: false, reason: 'issues', error: issues.error };

  const partial = [...(pullRequests.ok ? [] : ['pull-requests']), ...(commits === null ? ['commits'] : [])];
  // A closing reference recorded on the PR side links the issue the same way
  // the forge's own issue-side reference does.
  const linkedByIssue = new Map();
  for (const pullRequest of pullRequests.ok ? pullRequests.items : []) {
    for (const number of pullRequest.closesIssues) linkedByIssue.set(number, [...(linkedByIssue.get(number) || []), pullRequest.number]);
  }
  const linkedIssues = issues.issues.map((issue) => ({
    ...issue, linkedPullRequests: [...new Set([...issue.linkedPullRequests, ...(linkedByIssue.get(issue.number) || [])])],
  }));
  // A truncated read covers only the newest issues; count from the oldest one seen.
  const createdTimes = linkedIssues.map((issue) => Date.parse(issue.createdAt)).filter(Number.isFinite);
  const oldestCreated = issues.truncated && createdTimes.length ? Math.max(from, Math.min(...createdTimes)) : from;
  const report = computeLaneHealth({
    issues: linkedIssues, pullRequests: pullRequests.ok ? pullRequests.items : [], commits: commits || [],
    lanes: lane ? [lane] : lanes, now, windowDays, refileDays, from: oldestCreated,
  });
  return { ok: true, ...report, truncated: issues.truncated, partial };
}

/** The Quality page read: every lane, with the forge resolved from the app's tracker. */
export async function getAppLaneHealth(app, deps = {}) {
  const forge = await resolveForgeContext(app, {
    resolveTracker: resolveAppWorkTracker, resolveTokenEnv: resolveForgeTokenEnv, environment: process.env, ...deps,
  }).catch(() => null);
  const result = await collectLaneHealth(app, { forge, now: deps.now, deps });
  if (!result.ok) {
    const error = result.error != null ? describeForgeReadFailure({ cli: forge?.cli, stderr: result.error, host: forge?.host }) : null;
    if (error) console.warn(`⚠️ Lane health unavailable for ${app?.id}: ${error}`);
    return { available: false, reason: result.reason, ...(error ? { error } : {}) };
  }
  const { ok, ...health } = result;
  return { available: true, ...health };
}
