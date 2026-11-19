#!/usr/bin/env node

/**
 * "Is main red, and which merge turned it?" — the verdict a finished `main` CI
 * run owes its reader.
 *
 * `main` is tested on every push and twice a day. Each finished run lands here
 * (from `.github/workflows/main-health.yml`, a `workflow_run` consumer, because
 * a workflow called by release.yml cannot hold `issues: write`): a red run writes
 * the failing jobs and the merges since the last GREEN run to the step summary and
 * creates or updates the one open "main is red" issue; a green run closes it; a
 * cancelled run (a newer push superseded it) changes nothing.
 *
 * The summary is diagnostic and every lookup is best-effort. An unreadable base
 * is reported as unreadable, never as an empty range — "no merges" would clear
 * the suspects, "could not tell" does not. The issue sync is the opposite: a
 * failure to read or write the issue is reported as `syncFailed` so the job goes
 * red rather than silently leaving a stale or duplicate issue.
 *
 * Builtins only and nothing outside scripts/: the job checks out `scripts/`
 * alone and installs nothing (scripts/pre-install-entrypoints.test.js).
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  currentRunTargetFromEnv, fetchRunJobOutcomes, formatFailedJob, githubJson, githubRequest, isSuccess,
} from './lib/githubActionsApi.js';
import { safeWorkflowText, writeStepSummary } from './lib/githubOutput.js';

/** The compare API pages at 100 commits; a day's merges plus their parents fit. */
const COMPARE_PER_PAGE = 100;
const MAX_LISTED_MERGES = 60;
const API_TIMEOUT_MS = 10_000;
const ISSUES_PER_PAGE = 100;
const MAX_ISSUE_PAGES = 5;
export const MAIN_RED_TITLE = 'main is red';
const MAIN_RED_LABELS = ['bug', 'area:ci', 'model:medium', 'effort:medium'];
const RED_CONCLUSIONS = new Set(['failure', 'timed_out']);
const MAIN_EVENTS = new Set(['push', 'schedule']);
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
const GATE_JOB_NAMES = new Set(['CI Gate', 'Full CI Gate']);

const MERGE_COMMIT_RE = /^Merge pull request #(\d+) from \S+/;
const SQUASH_SUFFIX_RE = /\(#(\d+)\)$/;

/**
 * The pull requests a commit list merged, oldest first.
 *
 * A merge commit carries the title on its second line; a squash/rebase merge
 * carries `(#N)` on its first. Titles are contributor-controlled, so they pass
 * through the workflow-text sanitizer and are never rendered as links.
 *
 * @param {Array<{sha?: string, commit?: {message?: string}}>} commits
 * @returns {Array<{number: number, title: string, sha: string}>}
 */
export function mergedPullRequests(commits) {
  return (Array.isArray(commits) ? commits : []).flatMap((entry) => {
    const [first = '', second = ''] = String(entry?.commit?.message || '').split('\n').filter((line) => line.trim());
    const merge = MERGE_COMMIT_RE.exec(first);
    const squash = SQUASH_SUFFIX_RE.exec(first.trim());
    if (!merge && !squash) return [];
    return [{
      number: Number((merge || squash)[1]),
      title: safeWorkflowText(merge ? second : first.trim().replace(SQUASH_SUFFIX_RE, '').trim(), 'untitled'),
      sha: String(entry?.sha || '').slice(0, 9),
    }];
  });
}

/**
 * The summary body.
 *
 * @param {object} input
 * @param {Array<{name: string, steps: string[]}>|null} input.failedJobs - null: unreadable
 * @param {{sha: string, runId: number|string}|null} input.base - last green scheduled run, null: none found
 * @param {string} input.head
 * @param {Array<{number: number, title: string, sha: string}>|null} input.pulls - null: range unreadable
 * @param {boolean} [input.truncated] - the compare listing was cut short
 * @returns {string}
 */
export function buildNightlyReport({ failedJobs, base, head, pulls, truncated = false }) {
  const short = (sha) => String(sha || '').slice(0, 9);
  const lines = ['## CI on main failed — suspect merges', ''];

  if (failedJobs === null) lines.push("Failing jobs: **could not be read** — open the run's job logs.");
  else if (!failedJobs.length) lines.push('Failing jobs: none could be identified — open the run.');
  else lines.push('Failing jobs:', ...failedJobs.map((job) => `- ${formatFailedJob(job)}`));
  lines.push('');

  if (!base) {
    lines.push(`No earlier green run was found, so the suspect range is unknown (tested \`${short(head)}\`).`);
    return lines.join('\n');
  }
  lines.push(`Last green run: #${base.runId} at \`${short(base.sha)}\`; this run tested \`${short(head)}\`.`);
  if (pulls === null) {
    lines.push('', `The commit range could not be read: compare \`${short(base.sha)}...${short(head)}\` by hand.`);
    return lines.join('\n');
  }
  if (!pulls.length) {
    lines.push('', 'No pull request merged in that range: suspect a flake, a runner/dependency change, or the base itself.');
    return lines.join('\n');
  }
  const listed = pulls.slice(-MAX_LISTED_MERGES).reverse();
  lines.push('', `${pulls.length} pull request(s) merged since (newest first) — the first bad merge is among them:`, '');
  lines.push(...listed.map(({ number, title, sha }) => `- #${number} ${title} (\`${sha}\`)`));
  if (pulls.length > listed.length) lines.push('', 'List truncated: the oldest merges in the range are not shown.');
  // The compare API returns commits oldest-first, so a cut-off listing loses the NEWEST.
  if (truncated) lines.push('', `The compare listing holds only the first ${COMPARE_PER_PAGE} commits of the range: the newest merges are not shown.`);
  lines.push(
    '',
    'To bisect, run the failing suite at a merge in the middle of the list (`git checkout <sha>`) and halve the range.',
  );
  return lines.join('\n');
}


/**
 * The most recent successful push or scheduled run on main other than this one.
 * Pull-request runs are excluded: a fork branch can be named `main`.
 *
 * @returns {Promise<{sha: string, runId: number}|null>}
 */
async function findLastGreenMainRun(target, fetchImpl, logger) {
  const url = `${target.repoPath}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=30`;
  const body = await githubJson(fetchImpl, url, target.token, { timeoutMs: API_TIMEOUT_MS, logger });
  const run = (Array.isArray(body?.workflow_runs) ? body.workflow_runs : [])
    .find((candidate) => String(candidate?.id) !== target.runId
      && MAIN_EVENTS.has(candidate?.event) && HEX_SHA.test(candidate?.head_sha || ''));
  return run ? { sha: run.head_sha, runId: run.id } : null;
}

/**
 * The issue body: job names, the commit range and the run URL only. The suspect
 * pull-request list lives in the run summary, not in a tracker issue.
 *
 * @param {object} input
 * @param {Array<{name: string, steps: string[]}>|null} input.failedJobs
 * @param {{sha: string, runId: number|string}|null} input.base
 * @param {string} input.head
 * @param {string} input.runUrl
 * @param {string} input.compareBase - `https://<host>/<owner>/<repo>/compare`
 * @returns {string}
 */
export function buildMainRedIssueBody({ failedJobs, base, head, runUrl, compareBase }) {
  const short = (sha) => String(sha || '').slice(0, 9);
  const lines = ['The latest full CI run on `main` failed.', '', `Run: ${runUrl}`, `Tested commit: \`${short(head)}\``, ''];
  if (failedJobs === null) lines.push('Failed jobs: could not be read; open the run.');
  else if (!failedJobs.length) lines.push('Failed jobs: none could be identified; open the run.');
  else lines.push('Failed jobs:', ...failedJobs.map((job) => `- ${formatFailedJob(job)}`));
  lines.push('');
  if (!base) lines.push('Commit range: unknown, no earlier green run on `main` was found.');
  else lines.push(`Commit range since the last green run: ${compareBase}/${base.sha}...${head} (\`${short(base.sha)}...${short(head)}\`)`);
  lines.push('', 'This issue is updated by each further red run and closed by the next green one. The run summary lists the merged pull requests in the range.');
  return lines.join('\n');
}

/** The open "main is red" issue record, `null` when none, `undefined` when the listing failed. */
async function findOpenMainRedIssue(target, fetchImpl, logger) {
  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const issues = await githubJson(
      fetchImpl,
      `${target.repoPath}/issues?state=open&labels=${encodeURIComponent('area:ci')}&per_page=${ISSUES_PER_PAGE}&page=${page}`,
      target.token,
      { timeoutMs: API_TIMEOUT_MS, logger },
    );
    if (!Array.isArray(issues)) return undefined;
    // The issues endpoint also lists pull requests.
    const hit = issues.find((issue) => !issue?.pull_request && issue?.title === MAIN_RED_TITLE);
    if (hit) return hit;
    if (issues.length < ISSUES_PER_PAGE) return null;
  }
  return null;
}

async function writeIssue(fetchImpl, target, logger, method, path, payload) {
  try {
    const response = await githubRequest(fetchImpl, `${target.repoPath}${path}`, target.token, {
      method,
      timeoutMs: API_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (isSuccess(response)) return true;
    logger.error?.(`⚠️ ${method} ${path.replace(/\d+/g, 'N')} returned ${response?.status}`);
  } catch (error) {
    logger.error?.(`⚠️ ${method} ${path.replace(/\d+/g, 'N')} failed: ${error?.message || 'network request failed'}`);
  }
  return false;
}

/**
 * Create, update or close the single "main is red" issue for one finished run.
 *
 * @returns {Promise<{action: 'created'|'updated'|'closed'|'none', ok: boolean}>}
 */
async function syncMainRedIssue({ red, target, fetchImpl, logger, body, runUrl, head }) {
  const existing = await findOpenMainRedIssue(target, fetchImpl, logger);
  if (existing === undefined) return { action: 'none', ok: false };
  if (red) {
    if (existing === null) {
      const ok = await writeIssue(fetchImpl, target, logger, 'POST', '/issues', { title: MAIN_RED_TITLE, body, labels: MAIN_RED_LABELS });
      return { action: 'created', ok };
    }
    const ok = await writeIssue(fetchImpl, target, logger, 'PATCH', `/issues/${existing.number}`, { body })
      && await writeIssue(fetchImpl, target, logger, 'POST', `/issues/${existing.number}/comments`, { body: `Still red at \`${head.slice(0, 9)}\`: ${runUrl}` });
    return { action: 'updated', ok };
  }
  if (existing === null) return { action: 'none', ok: true };
  const recovery = `Green again at \`${head.slice(0, 9)}\`: ${runUrl}`;
  const ok = await writeIssue(fetchImpl, target, logger, 'PATCH', `/issues/${existing.number}`, {
    state: 'closed',
    state_reason: 'completed',
    body: existing.body ? `${existing.body}\n\n${recovery}` : recovery,
  });
  return { action: 'closed', ok };
}

/**
 * Handle one finished CI run on main.
 *
 * Reads the run under test from `CI_RUN_*` (the `workflow_run` payload), not from
 * `GITHUB_RUN_ID`, which names the consumer workflow's own run.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{log?: Function, error?: Function}} [options.logger]
 * @param {Function} [options.writeSummary]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ran: boolean, inconclusive?: boolean, report?: string, action?: string, syncFailed?: boolean}>}
 */
export async function reportMainHealth({
  env = process.env,
  logger = console,
  writeSummary = writeStepSummary,
  fetchImpl = globalThis.fetch,
} = {}) {
  const conclusion = String(env.CI_RUN_CONCLUSION || '').trim();
  const head = String(env.CI_RUN_SHA || '').trim();
  const runId = String(env.CI_RUN_ID || '').trim();
  const target = currentRunTargetFromEnv({ ...env, GITHUB_RUN_ID: runId });
  const red = RED_CONCLUSIONS.has(conclusion);
  if (env.CI_RUN_BRANCH !== 'main' || !MAIN_EVENTS.has(env.CI_RUN_EVENT) || (!red && conclusion !== 'success')) {
    logger.log(`⏭️ Main health skipped: ${env.CI_RUN_EVENT || 'unknown'} run on ${env.CI_RUN_BRANCH || 'unknown'} concluded ${conclusion || 'unknown'}.`);
    return { ran: false };
  }
  if (!target || !HEX_SHA.test(head) || !/^\d+$/.test(runId)) {
    logger.log('⏭️ Main health skipped: no usable run environment.');
    return { ran: false };
  }
  const serverUrl = /^https:\/\/[a-z0-9.-]+$/i.test(env.GITHUB_SERVER_URL || '') ? env.GITHUB_SERVER_URL : 'https://github.com';
  const repoUrl = `${serverUrl}/${env.GITHUB_REPOSITORY}`;
  const runUrl = `${repoUrl}/actions/runs/${runId}`;

  let report;
  let issueBody = '';
  if (red) {
    const outcomes = await fetchRunJobOutcomes(fetchImpl, { ...target, timeoutMs: API_TIMEOUT_MS });
    const failedJobs = outcomes?.failed.filter(({ name }) => !GATE_JOB_NAMES.has(name)) ?? null;
    // The gate went red only because GitHub never ran a job (hosted-runner
    // capacity, #16488). Nothing about the tested commit was shown broken, so
    // the issue is left exactly as it was, like a superseded cancel.
    if (outcomes && !failedJobs.length && outcomes.neverStarted.length) {
      logger.log(`⏭️ Main health skipped: ${outcomes.neverStarted.join(', ')} never got a runner, so the run proved nothing.`);
      return { ran: false, inconclusive: true };
    }
    const lastGreen = await findLastGreenMainRun(target, fetchImpl, logger);
    let pulls = null;
    let truncated = false;
    if (lastGreen) {
      const compare = await githubJson(
        fetchImpl,
        `${target.repoPath}/compare/${lastGreen.sha}...${head}?per_page=${COMPARE_PER_PAGE}`,
        target.token,
        { timeoutMs: API_TIMEOUT_MS, logger },
      );
      if (Array.isArray(compare?.commits)) {
        pulls = mergedPullRequests(compare.commits);
        truncated = Number(compare.total_commits) > compare.commits.length;
      }
    }
    report = buildNightlyReport({ failedJobs, base: lastGreen, head, pulls, truncated });
    issueBody = buildMainRedIssueBody({ failedJobs, base: lastGreen, head, runUrl, compareBase: `${repoUrl}/compare` });
    logger.log(report);
    writeSummary(report);
  }

  const { action, ok } = await syncMainRedIssue({ red, target, fetchImpl, logger, body: issueBody, runUrl, head });
  const log = ok ? logger.log : logger.error;
  log.call(logger, `${ok ? '📋' : '⚠️'} main-is-red issue: ${action}${ok ? '' : ' (failed)'}`);
  return { ran: true, report, action, syncFailed: !ok };
}

if (isDirectlyInvoked(import.meta.url)) {
  const { syncFailed } = await reportMainHealth();
  if (syncFailed) process.exitCode = 1;
}
