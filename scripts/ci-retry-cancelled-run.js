#!/usr/bin/env node

/**
 * Re-dispatch a CI run that was cancelled with NO successor run — once.
 *
 * When several PRs build at the same time, GitHub cancels in-flight runs that
 * nothing in this repository asked it to cancel: no job failed, the in-workflow
 * `Report the failure, then cancel sibling CI jobs` step never ran, and no
 * newer run exists for the branch. The PR is then blocked behind a gate that
 * reports a cancel as if the tests were red (issue 7437). The same SHA passes
 * on the next attempt once the queue drains, so one re-dispatch clears it.
 *
 * Five guards keep that from becoming a retry loop or from re-running work
 * somebody deliberately stopped — the reasoning for each is the table under
 * "External cancellation and one automatic retry" in docs/GITHUB_ACTIONS.md.
 * The two least obvious, stated here because the code alone does not show them:
 *
 *   - `run_attempt === 1` IS the retry budget. `POST /rerun` re-runs the same
 *     run id as attempt 2, so attempt 2's cancel sees attempt 2 and stops.
 *     The budget is confirmed against the run's LIVE state, not only the
 *     event payload, because the payload is a snapshot: a human can re-run
 *     the same run, or the event can be redelivered, while this job is
 *     still queued behind the very backlog it exists to survive.
 *   - No job may have concluded `failure`/`timed_out`. This repository cancels
 *     its own run from a failing job (scripts/cancel-current-ci-run.js), which
 *     makes the RUN read `cancelled` while a job really did fail.
 *
 * An API call that cannot be completed is NOT treated as "guard passed": every
 * lookup failure returns without re-dispatching, because the cost of missing a
 * retry is one manual re-run and the cost of a wrong retry is a runaway loop.
 *
 * The re-dispatch is DELAYED — see RETRY_DELAY_MS — and every API-backed guard
 * is evaluated again after the wait, so a supersession or a human re-run that
 * lands during it still wins (issue 7439).
 *
 * The workflow that runs this is triggered by `workflow_run`, so it checks out
 * the DEFAULT branch — never the pull request's head. Nothing here executes,
 * imports, or interpolates repository content from the PR.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  githubJson, githubRequest, isSuccess, jobFailed, repoApiPath, trimmed,
} from './lib/githubActionsApi.js';
import { safeWorkflowText, writeStepSummary } from './lib/githubOutput.js';

const REQUEST_TIMEOUT_MS = 15_000;
/** ~1500 jobs. A bound, not an expectation — CI runs about fifteen. */
const MAX_JOB_PAGES = 15;
const JOBS_PER_PAGE = 100;
/** Newest-first; a successor, if one exists, is within the first few. */
const SIBLING_RUNS_PER_PAGE = 5;

/**
 * How long to idle before re-dispatching (issue 7439).
 *
 * The cancel this recovers from is caused by a saturated queue, so firing the
 * one-retry budget the instant the event arrives spends it at the moment it is
 * least likely to survive: on PR 7434 three re-runs of the IDENTICAL SHA were
 * each cancelled again while other runs were in flight, and that same SHA
 * passed on the first attempt made against an idle queue.
 *
 * Five minutes, because it is the smallest wait that plausibly outlives a
 * burst and the trade is lopsided: one job idling — not computing — for five
 * minutes against re-running twelve jobs straight into another cancel. It is
 * deliberately NOT "poll until the repository is quiet": on a busy repo that
 * can mean never retrying, which is worse than retrying into a cancel.
 *
 * Tune it from evidence, not intuition. Every recovery run's step summary
 * records the delay it used and whether the skip happened before or after the
 * wait, so the Actions history answers whether re-dispatched runs complete.
 */
export const RETRY_DELAY_MS = 5 * 60_000;

/**
 * The longest one invocation can take: the wait, plus TWO full guard passes at
 * their worst case — every job page and both run lookups each spending the
 * whole request timeout.
 *
 * The recovery job's `timeout-minutes` must exceed this, or a slow GitHub gets
 * the job killed mid-wait and silently turns "retried late" into "never
 * retried at all". Derived from the constants above rather than written down,
 * so raising MAX_JOB_PAGES or RETRY_DELAY_MS fails the workflow test instead of
 * quietly eating the margin.
 */
export const MAX_RUNTIME_MS = RETRY_DELAY_MS
  + 2 * (MAX_JOB_PAGES + 2) * REQUEST_TIMEOUT_MS;

/** Real elapsed time. Injected in tests so no suite ever sleeps. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The check run's name — stable, so every cancelled run reports under one
 * heading in the PR's Checks tab rather than a new name each time.
 */
const RECOVERY_CHECK_NAME = 'CI cancel recovery';
/**
 * ALWAYS `neutral`, never `failure`/`success`. This check EXPLAINS the gate; it
 * must never become a second one. `failure` would block a merge that branch
 * protection — which requires `CI Gate` alone — allows, and `success` would read
 * as a passing gate. PortOS's own auto-merge watcher (server/services/prWatcher.js)
 * already counts NEUTRAL as green, so neutral is the one conclusion that stays
 * purely informational to a human reader and to that watcher alike.
 */
const RECOVERY_CHECK_CONCLUSION = 'neutral';
/** A check run is created against a commit, so the sha has to be a real one. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * One sentence per reason code, for the PR reader looking at a bare red gate.
 *
 * Keyed by the SAME fixed reason codes the step summary renders, so the two
 * surfaces cannot drift. Fixed prose only — never the branch name or any other
 * payload text, for the reason `safeJobName` exists.
 */
const CHECK_REASON_TEXT = {
  're-dispatched': 'This run was cancelled with no successor run and no failing job, so CI was re-dispatched automatically — once. Watch the new run for the real result.',
  superseded: 'This run was cancelled because a newer CI run started for the same pull request. That newer run carries the real result, so this one was deliberately not retried.',
  'job-failed': 'This run was cancelled by CI itself after a job genuinely failed, which is why the run reads cancelled rather than failure. That is a real red, not queue contention, so it was not retried.',
  'retry-budget-exhausted': 'This run is already a retry attempt, and recovery re-dispatches a run at most once. Re-run it manually if it was cancelled externally again.',
  'run-state-moved-on': 'The run changed state after the cancellation event — it has already been re-run, or is no longer a completed cancellation — so the one-retry budget was left unspent.',
  'jobs-unavailable': "Recovery could not list this run's jobs, so it could not rule out a real job failure and did not retry. Re-run CI manually if the cancellation was external.",
  'run-state-unavailable': "Recovery could not read this run's current state, so it did not risk spending the one-retry budget on a stale reading. Re-run CI manually if the cancellation was external.",
  'sibling-runs-unavailable': "Recovery could not list the pull request's other runs, so it could not tell an external cancel from a supersession and did not retry. Re-run CI manually if the cancellation was external.",
  'rerun-rejected': 'Recovery tried to re-dispatch this run and GitHub rejected the request. Re-run CI manually.',
};
const CHECK_REASON_FALLBACK = 'Recovery evaluated this cancelled run and did not re-dispatch it. Re-run CI manually if the cancellation was external.';

/**
 * A job name for a log line. The name comes from the pull request's own
 * workflow file, and Actions parses `::` at the start of a line as a workflow
 * command — so newlines and `::` never reach stdout verbatim.
 */
const safeJobName = (job) => safeWorkflowText(job?.name, 'unnamed job');

/**
 * Validate and normalise the run this invocation may retry.
 *
 * Every field comes from the `workflow_run` payload, and `headBranch` is
 * attacker-controlled on a fork PR — it is only ever used as an encoded query
 * parameter, never interpolated into a path or a shell.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {object|null}
 */
export function retryTargetFromEnv(env) {
  const str = (key) => trimmed(env[key]);
  const token = str('GITHUB_TOKEN');
  const runId = str('CI_RUN_ID');
  const runAttempt = str('CI_RUN_ATTEMPT');
  const runNumber = str('CI_RUN_NUMBER');
  const workflowId = str('CI_WORKFLOW_ID');
  const headBranch = str('CI_RUN_HEAD_BRANCH');
  // Optional: absent on an older payload, so it narrows the sibling lookup
  // when present rather than invalidating the target when it is not.
  const headRepositoryId = str('CI_RUN_HEAD_REPOSITORY_ID');
  const repoPath = repoApiPath(env);

  if (!repoPath || !token || !headBranch) return null;
  if (![runId, runAttempt, runNumber, workflowId].every((value) => /^\d+$/.test(value))) return null;

  return {
    token,
    repoPath,
    runId,
    runAttempt: Number(runAttempt),
    runNumber: Number(runNumber),
    workflowId,
    headBranch,
    headRepositoryId: /^\d+$/.test(headRepositoryId) ? headRepositoryId : '',
    headSha: str('CI_RUN_HEAD_SHA'),
    conclusion: str('CI_RUN_CONCLUSION'),
    event: str('CI_RUN_EVENT'),
  };
}

const request = (fetchImpl, url, token, init) =>
  githubRequest(fetchImpl, url, token, { timeoutMs: REQUEST_TIMEOUT_MS, ...init });

/** Parsed body, or null for any transport, status, or parse failure. */
const readJson = (fetchImpl, url, token, logger) =>
  githubJson(fetchImpl, url, token, { timeoutMs: REQUEST_TIMEOUT_MS, logger });

/**
 * Every job of the cancelled attempt, or null when the listing is incomplete.
 * Null is deliberately distinct from `[]`: "we could not see the jobs" must
 * never read as "no job failed".
 */
async function fetchAttemptJobs(fetchImpl, target, logger) {
  const jobs = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const url = `${target.repoPath}/actions/runs/${target.runId}/attempts/${target.runAttempt}`
      + `/jobs?per_page=${JOBS_PER_PAGE}&page=${page}`;
    const body = await readJson(fetchImpl, url, target.token, logger);
    if (!body || !Array.isArray(body.jobs)) return null;
    jobs.push(...body.jobs);
    const total = Number(body.total_count);
    // Only a real total can certify that the listing is complete.
    if (!Number.isFinite(total)) return null;
    if (jobs.length >= total) return jobs;
    // Checked last, so `total: 0` still returns the legitimately empty list.
    if (body.jobs.length === 0) return null;
  }
  return null;
}

/**
 * The run's state as GitHub holds it NOW, or null when it cannot be read.
 *
 * Everything else here comes from the `workflow_run` payload, which is a
 * snapshot taken when the run completed. This job can start long after that —
 * it queues behind the same backlog that caused the cancel — so the payload
 * can say "attempt 1, cancelled" while a human has already re-run it. Spending
 * the one-retry budget on that stale reading is how one retry becomes three.
 */
async function fetchLiveRunState(fetchImpl, target, logger) {
  const url = `${target.repoPath}/actions/runs/${target.runId}`;
  const body = await readJson(fetchImpl, url, target.token, logger);
  if (!body) return null;
  return {
    runAttempt: Number(body.run_attempt),
    status: typeof body.status === 'string' ? body.status : '',
    conclusion: typeof body.conclusion === 'string' ? body.conclusion : '',
  };
}

/**
 * The run number of the newest sibling run, or null when the listing failed.
 * `run_number` increases monotonically per workflow, so taking the maximum
 * orders runs without trusting either the page order or timestamps that can
 * tie at second resolution.
 */
async function fetchNewestSiblingRunNumber(fetchImpl, target, logger) {
  const url = `${target.repoPath}/actions/workflows/${encodeURIComponent(target.workflowId)}/runs`
    + `?event=pull_request&per_page=${SIBLING_RUNS_PER_PAGE}`
    + `&branch=${encodeURIComponent(target.headBranch)}`;
  const body = await readJson(fetchImpl, url, target.token, logger);
  if (!body || !Array.isArray(body.workflow_runs)) return null;
  return body.workflow_runs
    .filter((run) => String(run?.id) !== target.runId)
    // `branch=` matches head_branch alone, so two forks pushing `patch-1`
    // land in the same listing and one would read as the other's successor.
    // Only a missed retry, but the numeric repository id rules it out.
    .filter((run) => !target.headRepositoryId
      || String(run?.head_repository?.id ?? target.headRepositoryId) === target.headRepositoryId)
    .reduce((newest, run) => Math.max(newest, Number(run?.run_number) || 0), 0);
}

/**
 * Every guard that needs the API, in one pass.
 *
 * Extracted because it runs TWICE — once before the wait, so an obviously
 * ineligible run skips without occupying a runner for five minutes, and once
 * after it, because that is the reading the re-dispatch is actually made on.
 * Re-reading is not merely defensive: a supersession or a human re-run can
 * land during the wait, and the post-wait job listing is also the more
 * reliable one, since a failing job's step records can still be settling when
 * the run's own cancel lands (see `jobFailed`).
 *
 * @returns {Promise<{level: string, message: string, result: object}|null>}
 *   null when every guard passes, otherwise the reason not to re-dispatch.
 */
async function evaluateApiGuards(fetchImpl, target, logger) {
  const jobs = await fetchAttemptJobs(fetchImpl, target, logger);
  if (!jobs) {
    return {
      level: 'error',
      message: `⚠️ CI retry skipped: could not list the jobs of run ${target.runId}`,
      result: { outcome: 'unavailable', reason: 'jobs-unavailable' },
    };
  }
  const failedJobs = jobs.filter(jobFailed).map(safeJobName);
  if (failedJobs.length) {
    return {
      level: 'log',
      message: `ℹ️ CI retry skipped: run ${target.runId} cancelled after a real failure (${failedJobs.join(', ')})`,
      result: { outcome: 'skipped', reason: 'job-failed' },
    };
  }

  const live = await fetchLiveRunState(fetchImpl, target, logger);
  if (!live) {
    return {
      level: 'error',
      message: `⚠️ CI retry skipped: could not read the current state of run ${target.runId}`,
      result: { outcome: 'unavailable', reason: 'run-state-unavailable' },
    };
  }
  if (live.runAttempt !== 1 || live.status !== 'completed' || live.conclusion !== 'cancelled') {
    return {
      level: 'log',
      message: `ℹ️ CI retry skipped: run ${target.runId} has moved on since the event (attempt ${live.runAttempt}, ${live.status}/${live.conclusion || 'no conclusion'})`,
      result: { outcome: 'skipped', reason: 'run-state-moved-on' },
    };
  }

  // Listed LAST, immediately before the POST, so the window in which a fresh
  // push could create a successor we do not see is as small as it can be.
  const newestSibling = await fetchNewestSiblingRunNumber(fetchImpl, target, logger);
  if (newestSibling === null) {
    return {
      level: 'error',
      message: `⚠️ CI retry skipped: could not list sibling runs for run ${target.runId}`,
      result: { outcome: 'unavailable', reason: 'sibling-runs-unavailable' },
    };
  }
  if (newestSibling > target.runNumber) {
    return {
      level: 'log',
      message: `ℹ️ CI retry skipped: run ${target.runId} was superseded by run #${newestSibling} on the same pull request`,
      result: { outcome: 'skipped', reason: 'superseded' },
    };
  }

  return null;
}

/**
 * Publish the verdict back onto the pull request as a NEUTRAL check run.
 *
 * This is the only layer that can explain a run-wide cancel (#7438). `if:
 * always()` on the CI gate defeats an upstream job failure, not a cancellation
 * of the whole run — when GitHub cancels the run externally the gate is
 * cancelled with it and prints nothing, so the PR shows a bare red `CI Gate`
 * and the explanation exists only on a separate workflow run nobody finds.
 *
 * BEST-EFFORT, always. A recovery job must never turn red on top of an already
 * cancelled run, so every failure here is logged and swallowed — the step
 * summary is still written and the process still exits 0.
 */
async function publishRecoveryCheck(fetchImpl, target, result, logger) {
  if (!COMMIT_SHA_PATTERN.test(target.headSha)) {
    logger?.error?.('⚠️ CI cancel recovery: no usable head sha, so no explanatory check run was published');
    return;
  }
  const reason = result.reason || 're-dispatched';
  const response = await request(fetchImpl, `${target.repoPath}/check-runs`, target.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: RECOVERY_CHECK_NAME,
      head_sha: target.headSha,
      status: 'completed',
      conclusion: RECOVERY_CHECK_CONCLUSION,
      output: {
        title: `${result.outcome}: ${reason}`,
        // The same fixed reason code the step summary renders, plus the
        // sentence that makes it actionable without opening another run.
        summary: `CI run ${target.runId} ended \`cancelled\`.\n\n`
          + `- outcome: \`${result.outcome}\`\n`
          + `- reason: \`${reason}\`\n\n`
          + `${CHECK_REASON_TEXT[reason] || CHECK_REASON_FALLBACK}\n\n`
          + 'This check is informational and always neutral — it never blocks a merge.',
      },
    }),
  }).catch((error) => {
    logger?.error?.(`⚠️ CI cancel recovery: could not publish the explanatory check run: ${error?.message || 'network request failed'}`);
    return null;
  });
  // A thrown request already logged its own reason above.
  if (!response || isSuccess(response)) return;
  logger?.error?.(`⚠️ CI cancel recovery: GitHub rejected the explanatory check run with ${Number(response.status) || 'an unknown status'}`);
}

/**
 * Decide whether the cancelled run deserves one re-dispatch, and do it.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{log?: Function, error?: Function}} [options.logger]
 * @param {Function} [options.writeSummary] - injectable step-summary writer
 * @param {number} [options.delayMs] - wait before re-dispatching
 * @param {(ms: number) => Promise<void>} [options.wait] - injectable clock; tests never sleep
 * @returns {Promise<{outcome: 'requested'|'skipped'|'unavailable', reason?: string, status?: number, phase?: string}>}
 */
export async function retryCancelledCiRun({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  writeSummary = writeStepSummary,
  delayMs = RETRY_DELAY_MS,
  wait = sleep,
} = {}) {
  const runLabel = /^\d+$/.test(String(env.CI_RUN_ID ?? '')) ? env.CI_RUN_ID : 'unidentified';
  // Every exit goes through here, so "why was my run not retried?" is
  // answerable from the recovery run's summary page. Fixed reason codes and
  // the numeric run id only — never the branch name or any other payload text.
  // `level` is a parameter rather than derived from `outcome`: an invalid
  // environment is a `skipped` outcome that still deserves stderr.
  // `phase` and `delay` are what make the Actions history measurable (7439):
  // they say whether an outcome was reached before or after the wait, and how
  // long that wait was, so a later tuning pass can read its own baseline
  // instead of guessing at summaries written under a since-changed constant.
  //
  // `checkTarget` stays null until the run is known to be a cancelled
  // pull-request run, because those are the only PRs with a gate to explain: a
  // run that concluded normally would get an unprompted check on a green PR,
  // and a non-PR run has no pull request to annotate at all.
  let phase = 'before-wait';
  let checkTarget = null;
  const done = async (level, message, result) => {
    logger[level]?.(message);
    writeSummary(`### CI cancel recovery: ${result.outcome}\n\n`
      + `- run: ${runLabel}\n`
      + `- reason: ${result.reason || 're-dispatched'}\n`
      + `- phase: ${phase}\n`
      + `- delay: ${Math.round(delayMs / 1000)}s`, env);
    if (checkTarget) await publishRecoveryCheck(fetchImpl, checkTarget, result, logger);
    return { ...result, phase };
  };

  const target = retryTargetFromEnv(env);
  if (!target) {
    return done('error', '⚠️ CI retry skipped: the workflow_run environment is incomplete or malformed',
      { outcome: 'skipped', reason: 'invalid-environment' });
  }
  if (typeof fetchImpl !== 'function') {
    return done('error', '⚠️ CI retry unavailable: fetch is not available',
      { outcome: 'unavailable', reason: 'fetch-unavailable' });
  }

  if (target.conclusion !== 'cancelled') {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} concluded ${target.conclusion || 'unknown'}, not cancelled`,
      { outcome: 'skipped', reason: 'not-cancelled' });
  }
  if (target.event !== 'pull_request') {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} was triggered by ${target.event || 'an unknown event'}, not a pull request`,
      { outcome: 'skipped', reason: 'not-a-pull-request' });
  }

  // From here on the run IS a cancelled pull-request run, so every remaining
  // exit — retried, skipped, or a lookup that failed, before or after the
  // wait — is published back onto the PR by `done`.
  checkTarget = target;
  if (target.runAttempt !== 1) {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} is already attempt ${target.runAttempt} — one retry per run`,
      { outcome: 'skipped', reason: 'retry-budget-exhausted' });
  }

  // Before the wait: a run that is DEFINITIVELY ineligible skips now rather
  // than holding a runner idle for the full delay.
  //
  // Only a `skipped` verdict short-circuits. An `unavailable` one is not
  // evidence of ineligibility, and a saturated GitHub — precisely the condition
  // this workflow exists for — is when a transient 5xx here is likeliest, so
  // forfeiting the retry on it would lose the very case the delay was added to
  // win. A failed lookup falls through to the wait and lets the post-wait pass
  // decide; that pass still fails CLOSED. This one is only an optimization, so
  // it may save time but must never spend the budget.
  const early = await evaluateApiGuards(fetchImpl, target, logger);
  if (early?.result.outcome === 'skipped') return done(early.level, early.message, early.result);

  logger.log?.(`⏳ Waiting ${Math.round(delayMs / 1000)}s before re-dispatching CI run ${target.runId}: the queue that cancelled it is likely still full`);
  await wait(delayMs);
  phase = 'after-wait';

  // After the wait: the reading the re-dispatch is actually made on. A newer
  // run for the branch, or a human re-run, may have landed during the delay.
  const late = await evaluateApiGuards(fetchImpl, target, logger);
  if (late) return done(late.level, late.message, late.result);

  const response = await request(
    fetchImpl,
    `${target.repoPath}/actions/runs/${target.runId}/rerun`,
    target.token,
    { method: 'POST' },
  ).catch((error) => {
    logger.error?.(`⚠️ CI retry request failed: ${error?.message || 'network request failed'}`);
    return null;
  });
  if (isSuccess(response)) {
    return done('log', `🔁 Re-dispatched CI run ${target.runId} (${target.headSha.slice(0, 7) || 'unknown sha'}): cancelled with no successor run and no failing job`,
      { outcome: 'requested', status: Number(response.status) || 0 });
  }
  const status = Number(response?.status) || 0;
  return done('error', `⚠️ Could not re-dispatch CI run ${target.runId}: GitHub API returned ${status || 'an unknown status'}`,
    { outcome: 'unavailable', status, reason: 'rerun-rejected' });
}

if (isDirectlyInvoked(import.meta.url)) {
  // Never fail the recovery workflow: a retry that could not happen must not
  // publish a red check of its own on top of the cancelled run.
  await retryCancelledCiRun();
}
