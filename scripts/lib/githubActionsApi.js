/**
 * Shared GitHub Actions REST plumbing for the CI gates in `scripts/`.
 *
 * Extracted because two scripts now talk to the Actions API from inside a
 * workflow — `cancel-current-ci-run.js` and `ci-retry-cancelled-run.js` — and
 * the piece they share is a SECURITY check, not boilerplate: `resolveApiBase`
 * decides which host a step-scoped `GITHUB_TOKEN` is sent to. Two copies of
 * that meant a hardening fix could land on one and silently miss the other.
 *
 * ZERO external dependencies — see githubOutput.js. The one internal import
 * is githubOutput's own sanitizer, so an API-sourced job or step name is safe
 * the moment it leaves here rather than at each call site.
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
 * The API origin to send the token to, or null to send it nowhere.
 *
 * An unset `GITHUB_API_URL` means github.com. A set one must be a plain
 * https origin: no embedded credentials (which would travel in the request
 * line), and no query or fragment (which would be silently dropped once a
 * path is appended, so the caller would not be talking to the URL it read).
 *
 * @param {string} [configuredApiUrl] - raw `GITHUB_API_URL`
 * @returns {string|null} base with no trailing slash
 */
export function resolveApiBase(configuredApiUrl) {
  const raw = trimmed(configuredApiUrl);
  if (!raw) return PUBLIC_API_BASE;
  // `new URL` in try/catch rather than the tidier `URL.parse`: that landed in
  // Node 22.1, and the recovery workflow deliberately runs on the runner image's
  // DEFAULT node with no setup-node. A TypeError here would take out every
  // recovery run on an older image instead of returning null.
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
 * `<base>/repos/<owner>/<repo>` from the Actions environment, or null.
 *
 * The repository is read only from `GITHUB_REPOSITORY`; no caller passes a
 * target in, so a pull request cannot redirect a request at another repo.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
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
 * One authenticated Actions API call with the standard headers and a timeout.
 *
 * A caller may add headers (a POST body needs its `Content-Type`), but never one
 * of the three fixed ones: this helper decides which host the token is sent to,
 * and a caller that could rewrite `Authorization` would take that decision back
 * out of here. Dropping them is case-INSENSITIVE, because `fetch` folds
 * `authorization` and `Authorization` into one comma-joined value — filtering
 * only the exact spelling would let a caller append to the header instead.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} token
 * @param {{method?: string, timeoutMs?: number, headers?: Record<string, string>}} [options]
 * @returns {Promise<Response>}
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
 * True for a 2xx response.
 *
 * Belt and braces: a real `Response` sets `ok` from the status, but these
 * callers inject `fetchImpl`, so a stub that reports only one of the two
 * still reads correctly.
 *
 * @param {{status?: number, ok?: boolean}} [response]
 */
export function isSuccess(response) {
  const status = Number(response?.status) || 0;
  return (status >= 200 && status < 300) || response?.ok === true;
}

/**
 * The run this step is part of, plus the token to read it with — or null.
 *
 * The single derivation of "which run am I, and with what token". Both the
 * fail-fast reporter and the gate reporter need it, and this module exists
 * precisely so a hardening fix to that reasoning cannot land on one copy and
 * miss the other.
 *
 * @param {NodeJS.ProcessEnv} env
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
 * failure — every caller treats "could not read" as its own outcome, never as
 * an empty result.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} token
 * @param {{timeoutMs?: number, logger?: {error?: Function}}} [options]
 * @returns {Promise<object|null>}
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
 * A conclusion that means something really broke, not that it was stopped.
 * `cancelled` is deliberately absent — this repository cancels its own run
 * from the failing job, so a cancel is usually the CONSEQUENCE of a failure.
 */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out']);

/**
 * The steps of one job that actually failed.
 *
 * A cancelled job KEEPS its steps' conclusions, which is the whole reason this
 * exists: `cancel-current-ci-run.js` cancels the run from inside the failing
 * job, so GitHub can record the job as `cancelled` while one of its steps is
 * `failure`. Nothing that reads only job conclusions — `gh pr checks`,
 * `gh run view --json jobs`, `gh run view --log-failed` — can see that (7574).
 */
const failedSteps = (job) => (Array.isArray(job?.steps) ? job.steps : [])
  .filter((step) => FAILING_CONCLUSIONS.has(step?.conclusion));

/** True when this job carries a real failure, at the job or the step level. */
export const jobFailed = (job) => FAILING_CONCLUSIONS.has(job?.conclusion)
  || failedSteps(job).length > 0;

/**
 * One culprit as both reporting surfaces render it. Shared so the Checks-tab
 * annotation and the gate summary — the two lines a human cross-reads — cannot
 * drift into describing the same failure differently.
 *
 * @param {{name: string, steps: string[]}} job
 * @returns {string}
 */
export const formatFailedJob = ({ name, steps }) => `${name} — failed step: ${steps.join(', ')}`;

/** CI runs about fifteen jobs; one page names them all. */
const RUN_JOBS_PER_PAGE = 100;

/**
 * Best-effort: the run's jobs that carry a failed STEP, named and sanitized.
 *
 * `null` means "could not be read" and is deliberately distinct from `[]`,
 * because the callers turn `[]` into a verdict ("nothing failed — this really
 * was a cancel") that a failed lookup must never produce.
 *
 * Names are sanitized HERE rather than at each call site: they come from a
 * workflow file and reach stdout, where Actions parses a leading `::` as a
 * command, so making that the boundary's job is what keeps a future consumer
 * from forgetting it.
 *
 * Deliberately single-page and deliberately NOT attempt-scoped: both callers
 * are diagnostics that run inside the run they are describing, where an
 * incomplete answer is worth more than a slow one. The retry guard in
 * `ci-retry-cancelled-run.js` needs the opposite trade and keeps its own
 * paginated, fail-closed listing.
 *
 * @param {typeof fetch} fetchImpl
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
