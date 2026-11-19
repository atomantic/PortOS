/**
 * Shared GitHub Actions REST plumbing for the CI gates in `scripts/`
 * (`ci-gate-report.js`, `ci-retry-cancelled-run.js`). The shared piece is a
 * SECURITY check: `resolveApiBase` decides which host a step-scoped
 * `GITHUB_TOKEN` is sent to, so it must not exist in two copies.
 *
 * ZERO external dependencies (see githubOutput.js); the one internal import is
 * its sanitizer, so API-sourced job/step names are safe the moment they leave here.
 */

import { safeWorkflowText } from './githubOutput.js';

export const GITHUB_API_VERSION = '2022-11-28';
const PUBLIC_API_BASE = 'https://api.github.com';
/** `owner/repo`, rejecting anything with a slash or whitespace in a segment. */
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Lowercased: HTTP header names are case-insensitive and `fetch` folds them. */
const FIXED_HEADER_NAMES = new Set(['accept', 'authorization', 'x-github-api-version']);

/** `String#trim` that tolerates a missing or non-string env value. */
export const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The API origin to send the token to, or null to send it nowhere. Unset
 * `GITHUB_API_URL` means github.com; a set one must be a plain https origin with
 * no embedded credentials (they would travel in the request line) and no query or
 * fragment (silently dropped once a path is appended).
 */
export function resolveApiBase(configuredApiUrl) {
  const raw = trimmed(configuredApiUrl);
  if (!raw) return PUBLIC_API_BASE;
  // `new URL` in try/catch, not `URL.parse` (Node 22.1+): the recovery workflow
  // runs on the runner image's DEFAULT node, where a TypeError would take out
  // every recovery run instead of returning null.
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * `<base>/repos/<owner>/<repo>` from the Actions environment, or null. The
 * repository is read only from `GITHUB_REPOSITORY` (no caller passes a target), so
 * a pull request cannot redirect a request at another repo.
 */
export function repoApiPath(env) {
  const repository = trimmed(env.GITHUB_REPOSITORY);
  if (!REPOSITORY_PATTERN.test(repository)) return null;
  const apiBase = resolveApiBase(env.GITHUB_API_URL);
  if (!apiBase) return null;
  const [owner, repo] = repository.split('/');
  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * One authenticated Actions API call with the standard headers and a timeout. A
 * caller may add headers (a POST needs `Content-Type`) but never the three fixed
 * ones, or it could take back the decision of which host gets the token. Dropping
 * is case-INSENSITIVE: `fetch` folds `authorization` and `Authorization` into one
 * comma-joined value, so an exact-spelling filter would let a caller append.
 *
 * @param {{method?: string, timeoutMs?: number, headers?: Record<string, string>}} [options]
 */
export function githubRequest(fetchImpl, url, token, { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...init } = {}) {
  const callerHeaders = Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => !FIXED_HEADER_NAMES.has(name.toLowerCase())),
  );
  return fetchImpl(url, {
    ...init,
    headers: {
      ...callerHeaders,
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * True for a 2xx response. Reads either `status` or `ok` because callers inject
 * `fetchImpl` and a stub may report only one.
 * @param {{status?: number, ok?: boolean}} [response]
 */
export function isSuccess(response) {
  const status = Number(response?.status) || 0;
  return (status >= 200 && status < 300) || response?.ok === true;
}

/**
 * The run this step is part of, plus the token to read it with, or null; the
 * single derivation of "which run am I", kept beside the API-host check.
 * @returns {{token: string, repoPath: string, runId: string}|null}
 */
export function currentRunTargetFromEnv(env) {
  const runId = trimmed(env.GITHUB_RUN_ID);
  const token = trimmed(env.GITHUB_TOKEN);
  const repoPath = repoApiPath(env);

  if (!repoPath || !/^\d+$/.test(runId) || !token) return null;

  return { token, repoPath, runId };
}

/**
 * One authenticated GET, parsed. `null` for ANY transport, status, or parse
 * failure: callers treat "could not read" as its own outcome, never as an empty result.
 * @param {{timeoutMs?: number, logger?: {error?: Function}}} [options]
 */
export async function githubJson(fetchImpl, url, token, { timeoutMs, logger } = {}) {
  try {
    const response = await githubRequest(fetchImpl, url, token, { timeoutMs });
    if (!isSuccess(response)) return null;
    return await response.json();
  } catch (error) {
    logger?.error?.(`⚠️ GitHub API request failed: ${error?.message || 'network request failed'}`);
    return null;
  }
}

/**
 * A conclusion that means something really broke. `cancelled` is absent on
 * purpose: this repository cancels its own run from the failing job, so a cancel
 * is usually the CONSEQUENCE of a failure.
 */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out']);

/**
 * The steps of one job that actually failed. A cancelled job KEEPS its steps'
 * conclusions: one cancelled mid-step is recorded `cancelled` while a step is
 * `failure`, which nothing reading only job conclusions (`gh pr checks`,
 * `gh run view --json jobs`/`--log-failed`) can see.
 */
const failedSteps = (job) => (Array.isArray(job?.steps) ? job.steps : [])
  .filter((step) => FAILING_CONCLUSIONS.has(step?.conclusion));

/** True when this job carries a real failure, at the job or the step level. */
export const jobFailed = (job) => FAILING_CONCLUSIONS.has(job?.conclusion)
  || failedSteps(job).length > 0;

/**
 * One culprit as both reporting surfaces render it, shared so the Checks-tab
 * annotation and the gate summary can't describe the same failure differently.
 * @param {{name: string, steps: string[], reason?: string}} job a `reason` replaces the failed-step list
 */
export const formatFailedJob = ({ name, steps, reason }) => (reason ? `${name} — ${reason}` : `${name} — failed step: ${steps.join(', ')}`);

/** CI runs about fifteen jobs; one page names them all. */
const RUN_JOBS_PER_PAGE = 100;

/**
 * Best-effort: the run's jobs that carry a failed STEP, named and sanitized.
 *
 * `null` means "could not be read", distinct from `[]`: callers turn `[]` into a
 * verdict ("nothing failed, this was a cancel") a failed lookup must never produce.
 * Names are sanitized HERE because they come from a workflow file and reach
 * stdout, where Actions parses a leading `::` as a command.
 *
 * Single-page and NOT attempt-scoped: both callers are diagnostics inside the run
 * they describe, where an incomplete answer beats a slow one. The retry guard in
 * `ci-retry-cancelled-run.js` needs the opposite trade and keeps its own
 * paginated, fail-closed listing.
 *
 * @param {{repoPath: string, runId: string, token: string, timeoutMs?: number}} [target]
 * @returns {Promise<Array<{name: string, steps: string[]}>|null>}
 */
export async function fetchJobsWithFailedSteps(fetchImpl, target) {
  const { repoPath, runId, token, timeoutMs } = target || {};
  if (typeof fetchImpl !== 'function' || !repoPath || !/^\d+$/.test(String(runId)) || !token) return null;
  const url = `${repoPath}/actions/runs/${runId}/jobs?per_page=${RUN_JOBS_PER_PAGE}`;
  const body = await githubJson(fetchImpl, url, token, { timeoutMs });
  if (!Array.isArray(body?.jobs)) return null;
  return body.jobs.flatMap((job) => {
    const failed = failedSteps(job);
    return failed.length
      ? [{
        name: safeWorkflowText(job?.name, 'unnamed job'),
        steps: failed.map((step) => safeWorkflowText(step?.name, 'unnamed step')),
      }]
      : [];
  });
}

/**
 * Best-effort verdict on every job of a finished run, for callers that must tell
 * "something broke" from "GitHub never ran a job".
 *
 * - `failed`: jobs with a failed step or a failure/timed_out conclusion, and jobs
 *   cancelled AFTER they started (a job-level timeout or a lost runner: the
 *   steps list is non-empty), each carrying a `reason` when no step failed.
 * - `neverStarted`: jobs cancelled with no steps at all, i.e. the hosted runner
 *   was never acquired ("The job was not acquired by Runner ... even after
 *   multiple attempts"). That is capacity, not a defect in the tested commit.
 *
 * `null` means "could not be read".
 *
 * @returns {Promise<{failed: Array<{name: string, steps: string[], reason?: string}>, neverStarted: string[]}|null>}
 */
export async function fetchRunJobOutcomes(fetchImpl, target) {
  const { repoPath, runId, runAttempt, token, timeoutMs } = target || {};
  if (typeof fetchImpl !== 'function' || !repoPath || !/^\d+$/.test(String(runId)) || !token) return null;
  if (runAttempt !== undefined && (!Number.isSafeInteger(runAttempt) || runAttempt < 1)) return null;
  const attempt = runAttempt === undefined ? '' : `/attempts/${runAttempt}`;
  const body = await githubJson(fetchImpl, `${repoPath}/actions/runs/${runId}${attempt}/jobs?per_page=${RUN_JOBS_PER_PAGE}`, token, { timeoutMs });
  if (!Array.isArray(body?.jobs) || body.total_count > body.jobs.length) return null;
  const failed = [];
  const neverStarted = [];
  for (const job of body.jobs) {
    const name = safeWorkflowText(job?.name, 'unnamed job');
    const steps = failedSteps(job).map((step) => safeWorkflowText(step?.name, 'unnamed step'));
    if (steps.length) failed.push({ name, steps });
    else if (job?.conclusion === 'timed_out') failed.push({ name, steps, reason: 'timed out' });
    else if (job?.conclusion === 'failure') failed.push({ name, steps, reason: 'failed without a failed step' });
    else if (job?.conclusion === 'cancelled') {
      if (Array.isArray(job.steps) && job.steps.length) {
        failed.push({ name, steps, reason: 'cancelled after it started (a job timeout or a lost runner)' });
      } else neverStarted.push(name);
    }
  }
  return { failed, neverStarted };
}
