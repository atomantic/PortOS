#!/usr/bin/env node

/**
 * "Which merge turned the nightly red?" — the range a failed scheduled run owes
 * its reader.
 *
 * `main` has no push trigger: every PR passes a scoped plan, and the scheduled
 * full run is the only thing that tests the combined tree. With dozens of PRs
 * merging a day, a red nightly is otherwise a bisect by hand. This names the
 * merges since the last GREEN scheduled run and the jobs/steps that failed, so
 * the suspect list is one summary away.
 *
 * Diagnostic only: it runs after the gate has already failed, so every lookup
 * is best-effort and the exit code is always 0. An unreadable base is reported
 * as unreadable, never as an empty range — "no merges" would clear the
 * suspects, "could not tell" does not.
 *
 * Builtins only and nothing outside scripts/: the gate job checks out
 * `scripts/` alone and installs nothing (scripts/pre-install-entrypoints.test.js).
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  currentRunTargetFromEnv, fetchJobsWithFailedSteps, formatFailedJob, githubJson,
} from './lib/githubActionsApi.js';
import { safeWorkflowText, writeStepSummary } from './lib/githubOutput.js';

/** The compare API pages at 100 commits; a day's merges plus their parents fit. */
const COMPARE_PER_PAGE = 100;
const MAX_LISTED_MERGES = 60;
const API_TIMEOUT_MS = 10_000;
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
  const lines = ['## Scheduled CI failed — suspect merges', ''];

  if (failedJobs === null) lines.push("Failing jobs: **could not be read** — open the run's job logs.");
  else if (!failedJobs.length) lines.push('Failing jobs: none carried a failed step (a cancel or timeout) — open the run.');
  else lines.push('Failing jobs:', ...failedJobs.map((job) => `- ${formatFailedJob(job)}`));
  lines.push('');

  if (!base) {
    lines.push(`No earlier green scheduled run was found, so the suspect range is unknown (tested \`${short(head)}\`).`);
    return lines.join('\n');
  }
  lines.push(`Last green scheduled run: #${base.runId} at \`${short(base.sha)}\`; this run tested \`${short(head)}\`.`);
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
 * The most recent successful scheduled CI run other than this one.
 *
 * @returns {Promise<{sha: string, runId: number}|null>}
 */
async function findLastGreenScheduledRun(target, fetchImpl, logger) {
  const url = `${target.repoPath}/actions/workflows/ci.yml/runs?event=schedule&status=success&per_page=5`;
  const body = await githubJson(fetchImpl, url, target.token, { timeoutMs: API_TIMEOUT_MS, logger });
  const run = (Array.isArray(body?.workflow_runs) ? body.workflow_runs : [])
    .find((candidate) => String(candidate?.id) !== target.runId && /^[0-9a-f]{7,40}$/i.test(candidate?.head_sha || ''));
  return run ? { sha: run.head_sha, runId: run.id } : null;
}

/**
 * Build and publish the report for the current (failed) scheduled run.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{log?: Function, error?: Function}} [options.logger]
 * @param {Function} [options.writeSummary]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ran: boolean, report?: string}>}
 */
export async function reportNightlyFailure({
  env = process.env,
  logger = console,
  writeSummary = writeStepSummary,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (env.GITHUB_EVENT_NAME !== 'schedule') return { ran: false };
  const target = currentRunTargetFromEnv(env);
  const head = String(env.GITHUB_SHA || '').trim();
  if (!target || !/^[0-9a-f]{7,40}$/i.test(head)) {
    logger.log('⏭️ Nightly report skipped: no usable run environment.');
    return { ran: false };
  }

  const failedJobs = (await fetchJobsWithFailedSteps(fetchImpl, { ...target, timeoutMs: API_TIMEOUT_MS }))
    ?.filter(({ name }) => !GATE_JOB_NAMES.has(name)) ?? null;
  const base = await findLastGreenScheduledRun(target, fetchImpl, logger);

  let pulls = null;
  let truncated = false;
  if (base) {
    const compare = await githubJson(
      fetchImpl,
      `${target.repoPath}/compare/${base.sha}...${head}?per_page=${COMPARE_PER_PAGE}`,
      target.token,
      { timeoutMs: API_TIMEOUT_MS, logger },
    );
    if (Array.isArray(compare?.commits)) {
      pulls = mergedPullRequests(compare.commits);
      truncated = Number(compare.total_commits) > compare.commits.length;
    }
  }

  const report = buildNightlyReport({ failedJobs, base, head, pulls, truncated });
  logger.log(report);
  writeSummary(report);
  return { ran: true, report };
}

if (isDirectlyInvoked(import.meta.url)) {
  await reportNightlyFailure();
}
