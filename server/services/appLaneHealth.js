/**
 * Lane health for an app's audit lanes (#12088): the forge and git reads behind
 * `lib/laneHealth.js`. One read per source; the `lane-health` task data input
 * narrows the issue read to the running lane's metric label, the Quality page
 * reads every lane at once.
 */

import { execGit } from '../lib/execGit.js';
import { withGlabJson } from '../lib/glabArgs.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { auditDomainFor } from '../lib/auditDomains.js';
import { auditLanes, computeLaneHealth, HISTORICAL_LANE_LABELS, LANE_HEALTH_WINDOW_DAYS, LANE_REFILE_WINDOW_DAYS } from '../lib/laneHealth.js';
import { resolveAppWorkTracker } from '../lib/workTracker.js';
import { resolveForgeTokenEnv } from './forgeAuth.js';
import { describeForgeReadFailure, resolveForgeContext, runForgeCli } from './taskDataInputs.js';

const DAY_MS = 86_400_000;
// Every lane of a busy install files thousands of issues in a window; the page
// read stops here and reports the window it actually covered.
const ALL_LANES_ISSUE_LIMIT = 1000;
const ONE_LANE_ISSUE_LIMIT = 500;
// Revert commits name few PRs; a lookup past these caps is a runaway revert storm, not a health signal.
const MAX_PR_NUMBER_LOOKUPS = 10;
const MAX_PR_SHA_LOOKUPS = 10;
const CACHE_TTL_MS = 5 * 60_000;
const PR_JSON_FIELDS = 'number,mergeCommit,commits,closingIssuesReferences,body';
const REVERT_SUBJECT = /^\s*revert\b/i;
// GitLab names a merge request `!N` and an issue `#N`; either may sit in a revert message.
const PR_NUMBER_REFERENCE = { gh: /(?<![\w#])#(\d+)(?!\d)/g, glab: /(?<![\w#!])[#!](\d+)(?!\d)/g };
const SHA_REFERENCE = /\b[0-9a-f]{7,40}\b/g;
// A `#N` in a revert message may be an issue; the forge answers that lookup with a not-found, which is not a failed read.
const NOT_FOUND = /could not resolve|not found|404|no pull requests? match/i;
const GIT_TIMEOUT_MS = 15_000;
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;

const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);
const labelNames = (labels) => (Array.isArray(labels) ? labels : [])
  .map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
const searchLabelTerm = (labels) => `label:${labels.map((label) => `"${label}"`).join(',')}`;
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

/**
 * Issues created since `since` (epoch ms), newest first; `label` narrows to one lane and
 * `labels` to any of several (a GitHub OR search; glab has no OR, so it reads unfiltered).
 */
async function listForgeIssuesSince({ cli, cwd, env, since, label = null, labels = null, limit = ALL_LANES_ISSUE_LIMIT, exec = runForgeCli } = {}) {
  if (!cwd || (cli !== 'gh' && cli !== 'glab')) return { ok: false, issues: [], truncated: false };
  const args = cli === 'glab'
    ? ['issue', 'list', '--all', '-P', String(limit), ...(label ? ['--label', label] : [])]
    : [
        'issue', 'list', '--state', 'all', '--limit', String(limit),
        '--search', `created:>=${dateOnly(since)} sort:created-desc${labels?.length ? ` ${searchLabelTerm(labels)}` : ''}`,
        ...(label ? ['--label', label] : []),
        '--json', 'number,title,labels,createdAt,closedAt,state,stateReason,body,url,closedByPullRequestsReferences',
      ];
  const parsed = parseRows(cli, await exec(cli, args, { cwd, env }));
  if (!parsed.ok) return { ok: false, issues: [], truncated: false, error: parsed.error };
  const issues = parsed.rows.map((item) => normalizeIssue(cli, item))
    .filter((issue) => !Number.isFinite(Date.parse(issue.createdAt)) || Date.parse(issue.createdAt) >= since);
  return { ok: true, issues, truncated: parsed.rows.length >= limit };
}

/**
 * The pull/merge requests a set of revert commits name, by `#N` reference or
 * (gh only) by a commit SHA the revert body cites. Reading only these, rather
 * than the newest merged PRs, sees a revert of any age in the window. `ok:false`
 * only when a lookup failed for a reason other than "no such pull request".
 */
async function listForgePullRequestsForReverts({ cli, cwd, env, reverts, exec = runForgeCli } = {}) {
  if (!cwd || (cli !== 'gh' && cli !== 'glab')) return { ok: false, items: [] };
  const numbers = new Set();
  const shas = new Set();
  for (const { subject, body } of reverts) {
    const text = `${subject}\n${body}`;
    for (const match of text.matchAll(PR_NUMBER_REFERENCE[cli])) numbers.add(match[1]);
    for (const match of text.toLowerCase().matchAll(SHA_REFERENCE)) shas.add(match[0]);
  }
  const lookups = [
    ...[...numbers].slice(0, MAX_PR_NUMBER_LOOKUPS).map((number) => (cli === 'glab'
      ? withGlabJson(['mr', 'view', number])
      : ['pr', 'view', number, '--json', PR_JSON_FIELDS])),
    ...(cli === 'gh' ? [...shas].slice(0, MAX_PR_SHA_LOOKUPS).map((sha) => (
      ['pr', 'list', '--state', 'merged', '--limit', '5', '--search', sha, '--json', PR_JSON_FIELDS])) : []),
  ];
  const results = await Promise.all(lookups.map((args) => exec(cli, args, { cwd, env })));
  const byNumber = new Map();
  let failed = false;
  results.forEach((result) => {
    if (result.code !== 0) {
      if (!NOT_FOUND.test(result.stderr || '')) failed = true;
      return;
    }
    const parsed = safeJSONParse(result.stdout || '', null, { logError: false });
    const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : null);
    if (!rows) { failed = true; return; }
    for (const row of rows) {
      const item = normalizePullRequest(cli, row);
      if (item.number != null) byNumber.set(item.number, item);
    }
  });
  return { ok: !failed, items: [...byNumber.values()] };
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

const cache = new Map();
const inflight = new Map();

/** Drop every cached lane-health read (tests; a forge reconfiguration). */
export function clearLaneHealthCache() {
  cache.clear();
  inflight.clear();
}

/**
 * Lane health shared per (repo, lane, forge CLI): every scheduled audit launch and
 * Quality page open would otherwise repeat the same paginated forge reads. A fresh
 * entry is served for 5 minutes, concurrent reads share one in-flight promise, and
 * `refresh` skips the stored entry. Failed reads are never stored.
 */
export function collectLaneHealth(app, options = {}) {
  const { forge, taskType = null, refresh = false } = options;
  if (!forge || !app?.repoPath) return readLaneHealth(app, options);
  const key = `${app.repoPath}\0${taskType || 'all'}\0${forge.cli}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.result);
  const pending = inflight.get(key);
  if (pending) return pending;
  // A clear while this read runs must not let it repopulate the cache or evict a newer in-flight read.
  const read = readLaneHealth(app, options).then((result) => {
    if (result.ok && inflight.get(key) === read) cache.set(key, { at: Date.now(), result });
    return result;
  }).finally(() => { if (inflight.get(key) === read) inflight.delete(key); });
  inflight.set(key, read);
  return read;
}

/**
 * @param {object} app - managed app (`repoPath`)
 * @param {object} options
 * @param {object|null} options.forge - resolved `{ cli, env, host }` (see `resolveForgeContext`)
 * @param {string|null} [options.taskType] - one audit lane; omitted reads every lane
 * @param {boolean} [options.refresh] - bypass the 5-minute cache
 * @returns {Promise<object>} `{ ok: false, reason, error? }` or the `computeLaneHealth` report
 *   plus `ok: true`, `truncated` and `partial` (sources whose read failed).
 */
async function readLaneHealth(app, { forge, taskType = null, now = Date.now(), deps = {} } = {}) {
  if (!forge || !app?.repoPath) return { ok: false, reason: 'forge-unavailable' };
  const lanes = auditLanes();
  const lane = taskType ? lanes.find((candidate) => candidate.id === auditDomainFor(taskType)) : null;
  if (taskType && !lane) return { ok: false, reason: 'not-an-audit-lane' };
  const consolidated = lane && Object.hasOwn(HISTORICAL_LANE_LABELS, lane.id);
  const singleMetric = lane && !consolidated;
  // A grouped audit owns findings under its own and its members' metric labels;
  // a GitHub OR search keeps the read to those instead of every issue in the repo.
  const domainLabels = consolidated && forge.cli === 'gh'
    ? [...new Set([lane.metricLabel, ...HISTORICAL_LANE_LABELS[lane.id], `source:${lane.id}`])]
    : null;
  const windowDays = LANE_HEALTH_WINDOW_DAYS;
  const refileDays = LANE_REFILE_WINDOW_DAYS;
  const from = now - windowDays * DAY_MS;
  const forgeOptions = { cli: forge.cli, cwd: app.repoPath, env: forge.env };
  // `deps.exec` / `deps.runGit` replace the forge CLI and git spawns.
  const exec = deps.exec || runForgeCli;
  const limit = singleMetric || domainLabels ? ONE_LANE_ISSUE_LIMIT : ALL_LANES_ISSUE_LIMIT;
  const readReverts = async () => {
    const allCommits = await listRevertCommitsSince(app.repoPath, from, { runGit: deps.runGit || execGit });
    const revertCommits = allCommits && allCommits.filter((commit) => REVERT_SUBJECT.test(commit.subject));
    // Pull requests matter only to revert detection: with no revert commit (or an
    // unreadable log) there is nothing to match, so the forge is not asked.
    const found = revertCommits?.length
      ? await listForgePullRequestsForReverts({ ...forgeOptions, reverts: revertCommits, exec })
      : { ok: true, items: [] };
    return { commits: revertCommits, pullRequests: found };
  };
  const [issues, { commits, pullRequests }] = await Promise.all([
    listForgeIssuesSince({ ...forgeOptions, since: from - refileDays * DAY_MS, label: singleMetric ? lane.metricLabel : null, labels: domainLabels, limit, exec }),
    readReverts(),
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
    lanes: singleMetric ? [lane] : lanes, now, windowDays, refileDays, from: oldestCreated,
  });
  if (lane) report.lanes = report.lanes.filter(row => row.id === lane.id);
  return { ok: true, ...report, truncated: issues.truncated, partial };
}

/** The Quality page read: every lane, with the forge resolved from the app's tracker. */
export async function getAppLaneHealth(app, { refresh = false, ...deps } = {}) {
  const forge = await resolveForgeContext(app, {
    resolveTracker: resolveAppWorkTracker, resolveTokenEnv: resolveForgeTokenEnv, environment: process.env, ...deps,
  }).catch(() => null);
  const result = await collectLaneHealth(app, { forge, now: deps.now, deps, refresh });
  if (!result.ok) {
    const error = result.error != null ? describeForgeReadFailure({ cli: forge?.cli, stderr: result.error, host: forge?.host }) : null;
    if (error) console.warn(`⚠️ Lane health unavailable for ${app?.id}: ${error}`);
    return { available: false, reason: result.reason, ...(error ? { error } : {}) };
  }
  const { ok, ...health } = result;
  return { available: true, ...health };
}
