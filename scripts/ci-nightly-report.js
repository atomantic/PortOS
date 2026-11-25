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
 * CI run and job state must be readable before changing the alert. Compare
 * lookups are diagnostic and best-effort. An unreadable base
 * is reported as unreadable, never as an empty range — "no merges" would clear
 * the suspects, "could not tell" does not. A failure to read or write the issue
 * is reported as `syncFailed` so the job goes
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
const RUNS_PER_PAGE = 100;
export const MAIN_RED_TITLE = 'main is red';
const MAIN_RED_LABELS = ['bug', 'area:ci', 'model:medium', 'effort:medium'];
const RED_CONCLUSIONS = new Set(['failure', 'timed_out']);
const MAIN_EVENTS = new Set(['push', 'schedule']);
const isMainRun = (run) => run?.head_branch === 'main' && MAIN_EVENTS.has(run.event);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
const GATE_JOB_NAMES = new Set(['CI Gate', 'Full CI Gate']);
// The primary server suite runs on every complete main plan and is skipped by the generated-snapshot plan (#18457).
const FULL_PLAN_EVIDENCE_JOB = /^Server tests \(/;

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
 * @param {{sha: string, runId: number|string}|null} input.base - last green push or scheduled run, null: none found
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


/** Read the current attempts of recent main runs, newest original run first. */
async function readMainRuns(target, fetchImpl, logger) {
  const url = `${target.repoPath}/actions/workflows/ci.yml/runs?branch=main&per_page=${RUNS_PER_PAGE}`;
  const body = await githubJson(fetchImpl, url, target.token, { timeoutMs: API_TIMEOUT_MS, logger });
  if (!Array.isArray(body?.workflow_runs)) return null;
  const runs = body.workflow_runs.filter(isMainRun);
  if (!runs.every(isUsableRun)) return null;
  return runs.sort((a, b) => b.run_number - a.run_number);
}

function isUsableRun(run) {
  return positiveInteger(run.id) && positiveInteger(run.run_number) && positiveInteger(run.run_attempt)
    && HEX_SHA.test(run.head_sha || '') && typeof run.status === 'string'
    && (run.status !== 'completed' || typeof run.conclusion === 'string');
}

async function readMainRun(target, fetchImpl, logger) {
  const url = `${target.repoPath}/actions/runs/${target.runId}`;
  const run = await githubJson(fetchImpl, url, target.token, { timeoutMs: API_TIMEOUT_MS, logger });
  const path = typeof run?.path === 'string' && run.path.split('@', 1)[0];
  return path === '.github/workflows/ci.yml' && isMainRun(run) && isUsableRun(run) ? run : null;
}

async function readRedJobs(run, target, fetchImpl) {
  const outcomes = await fetchRunJobOutcomes(fetchImpl, {
    ...target, runId: String(run.id), runAttempt: run.run_attempt, timeoutMs: API_TIMEOUT_MS,
  });
  if (!outcomes) return null;
  return { ...outcomes, failed: outcomes.failed.filter(({ name }) => !GATE_JOB_NAMES.has(name)) };
}

function isCapacityOnly({ failed, neverStarted }) {
  // A red gate caused solely by an unacquired runner says nothing about the commit (#16488).
  return !failed.length && neverStarted.length > 0;
}

/** A newer original run keeps its last verdict while an inconclusive retry is in flight or finished. */
async function readNewerVerdict(run, target, fetchImpl, logger) {
  let attempt = run;
  while (true) {
    if (attempt.status === 'completed') {
      if (attempt.conclusion === 'success') return true;
      if (RED_CONCLUSIONS.has(attempt.conclusion)) {
        const outcomes = await readRedJobs(attempt, target, fetchImpl);
        if (!outcomes) return null;
        if (!isCapacityOnly(outcomes)) return true;
      }
    }
    const previous = attempt.run_attempt - 1;
    if (!previous) return false;
    const url = `${target.repoPath}/actions/runs/${run.id}/attempts/${previous}`;
    attempt = await githubJson(fetchImpl, url, target.token, { timeoutMs: API_TIMEOUT_MS, logger });
    if (!attempt || attempt.id !== run.id || attempt.run_attempt !== previous
      || attempt.status !== 'completed' || typeof attempt.conclusion !== 'string') return null;
  }
}

/** Whether a green run proved the complete primary plan (a generated-snapshot push is green without it); null when the jobs cannot be read. */
async function ranFullPlan(run, target, fetchImpl) {
  const outcomes = await fetchRunJobOutcomes(fetchImpl, {
    ...target, runId: String(run.id), runAttempt: run.run_attempt, timeoutMs: API_TIMEOUT_MS,
  });
  return outcomes ? outcomes.succeeded.some((name) => FULL_PLAN_EVIDENCE_JOB.test(name)) : null;
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

/**
 * The line a green run appends as it closes the issue. Claim verification
 * (server/services/mainHealthClosure.js) reads it as the pointer to the green CI
 * run, then proves that run and this job's closure through the Actions API, so
 * keep it the body's last line and keep both sides in step.
 */
export const mainHealthRecoveryLine = (head, runUrl) => `Green again at \`${head.slice(0, 9)}\`: ${runUrl}`;

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
async function syncMainRedIssue({ existing, red, target, fetchImpl, logger, body, runUrl, head }) {
  if (red) {
    if (existing === null) {
      const ok = await writeIssue(fetchImpl, target, logger, 'POST', '/issues', { title: MAIN_RED_TITLE, body, labels: MAIN_RED_LABELS });
      return { action: 'created', ok };
    }
    const ok = await writeIssue(fetchImpl, target, logger, 'PATCH', `/issues/${existing.number}`, { body })
      && await writeIssue(fetchImpl, target, logger, 'POST', `/issues/${existing.number}/comments`, { body: `Still red at \`${head.slice(0, 9)}\`: ${runUrl}` });
    return { action: 'updated', ok };
  }
  const recovery = mainHealthRecoveryLine(head, runUrl);
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
  const noChange = { ran: true, action: 'none', syncFailed: false };
  const syncFailure = (message) => {
    logger.error?.(`⚠️ Main health could not sync the issue: ${message}`);
    return { ran: true, report, action: 'none', syncFailed: true };
  };
  let existing;
  if (!red) {
    existing = await findOpenMainRedIssue(target, fetchImpl, logger);
    if (existing === undefined) return syncFailure('the open issue list could not be read.');
    if (existing === null) return noChange;
  }

  const runs = await readMainRuns(target, fetchImpl, logger);
  if (!runs) return syncFailure('recent main CI runs could not be read.');
  const listedRun = runs.find((run) => String(run.id) === runId);
  // Older reruns can lie outside the recent page. Read their run number so a
  // known newer verdict can still supersede them, but never write from that gap.
  const current = listedRun ?? await readMainRun(target, fetchImpl, logger);
  if (!current || String(current.id) !== runId || current.head_sha !== head || current.event !== env.CI_RUN_EVENT) {
    return syncFailure(`event run #${runId} could not be verified against main CI.`);
  }
  if (current.status !== 'completed' || current.conclusion !== conclusion) {
    logger.log(`⏭️ Main health skipped: event for run #${runId} no longer matches its current attempt.`);
    return noChange;
  }

  let issueBody = '';
  let outcomes;
  if (red && listedRun) {
    outcomes = await readRedJobs(current, target, fetchImpl);
    if (outcomes && isCapacityOnly(outcomes)) {
      logger.log(`⏭️ Main health skipped: ${outcomes.neverStarted.join(', ')} never got a runner, so the run proved nothing.`);
      return { ran: false, inconclusive: true };
    }
    const failedJobs = outcomes?.failed ?? null;
    const earlier = runs.find((run) => run.run_number < current.run_number
      && run.status === 'completed' && run.conclusion === 'success');
    const lastGreen = earlier ? { sha: earlier.head_sha, runId: earlier.id } : null;
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

  for (const run of runs) {
    if (run.run_number <= current.run_number) break;
    const verdict = await readNewerVerdict(run, target, fetchImpl, logger);
    if (verdict === null) return syncFailure(`the verdict for newer CI run #${run.id} could not be read.`);
    if (!verdict) continue;
    logger.log(`⏭️ Main health skipped: newer CI run #${run.id} supersedes run #${runId}.`);
    return { ...noChange, report };
  }
  if (!listedRun) return syncFailure(`run #${runId} is outside the recent main CI run list, with no newer verdict found there.`);
  if (red) {
    if (!outcomes) return syncFailure(`jobs for CI run #${runId} attempt ${current.run_attempt} could not be read.`);
    existing = await findOpenMainRedIssue(target, fetchImpl, logger);
    if (existing === undefined) return syncFailure('the open issue list could not be read.');
  }

  const fullPlan = red ? true : await ranFullPlan(current, target, fetchImpl);
  if (fullPlan === null) return syncFailure(`jobs for CI run #${runId} could not be read.`);
  if (!fullPlan) {
    logger.log(`⏭️ Main health skipped: run #${runId} was scoped (no server suite ran), so it cannot close the alert.`);
    return noChange;
  }

  const { action, ok } = await syncMainRedIssue({ existing, red, target, fetchImpl, logger, body: issueBody, runUrl, head });
  const log = ok ? logger.log : logger.error;
  log.call(logger, `${ok ? '📋' : '⚠️'} main-is-red issue: ${action}${ok ? '' : ' (failed)'}`);
  return { ran: true, report, action, syncFailed: !ok };
}

if (isDirectlyInvoked(import.meta.url)) {
  const { syncFailed } = await reportMainHealth();
  if (syncFailed) process.exitCode = 1;
}
