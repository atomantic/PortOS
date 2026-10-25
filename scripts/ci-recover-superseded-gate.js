/** Recover only a superseded run whose sole unfinished job is a queued CI Gate.
 * Runs from the trusted default branch, never from PR source. No result/check
 * is rewritten: genuine failures and completed logs remain on the old run.
 */
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { githubJson, githubRequest, repoApiPath, trimmed } from './lib/githubActionsApi.js';
import { writeStepSummary } from './lib/githubOutput.js';

export const CANCEL_SETTLE_MS = 45_000;
const TERMINAL = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']);
const PENDING = new Set(['queued', 'requested', 'waiting', 'pending']);
const positiveId = (value) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const sha = (value) => /^[a-f0-9]{40}$/.test(value || '');

function targetFromEnv(env) {
  const target = {
    repo: trimmed(env.GITHUB_REPOSITORY), repoId: Number(env.GITHUB_REPOSITORY_ID),
    token: trimmed(env.GITHUB_TOKEN), base: repoApiPath(env),
    id: Number(env.CI_RUN_ID), workflowId: Number(env.CI_WORKFLOW_ID),
    head: trimmed(env.CI_RUN_HEAD_SHA), headRepoId: Number(env.CI_RUN_HEAD_REPOSITORY_ID),
  };
  return target.base && target.token && sha(target.head)
    && [target.repoId, target.id, target.workflowId, target.headRepoId].every(positiveId) ? target : null;
}

const onePr = (run) => Array.isArray(run?.pull_requests) && run.pull_requests.length === 1
  && positiveId(run.pull_requests[0]?.number) ? run.pull_requests[0].number : null;
const completed = (run) => run?.status === 'completed' && TERMINAL.has(run.conclusion);

function boundRun(run, target) {
  return positiveId(run?.id) && positiveId(run.run_number) && run.run_attempt === 1
    && run.workflow_id === target.workflowId && run.event === 'pull_request'
    && run.repository?.id === target.repoId && run.repository.full_name === target.repo
    && run.head_repository?.id === target.headRepoId && sha(run.head_sha)
    && typeof run.head_branch === 'string' && run.head_branch.length > 0 && onePr(run) !== null;
}

/** Complete one-page listings only. More than 100 jobs/runs is a refusal, never
 * evidence that omitted jobs finished. This bounds both API work and ambiguity.
 */
function completeList(body, key) {
  const rows = body?.[key];
  return Array.isArray(rows) && Number.isInteger(body.total_count) && body.total_count <= 100
    && body.total_count === rows.length && rows.every((row) => positiveId(row?.id))
    && new Set(rows.map((row) => row.id)).size === rows.length ? rows : null;
}

function queuedAggregateOnly(jobs, runId) {
  if (!jobs || jobs.length < 2 || jobs.some((job) => job.run_id !== runId)) return false;
  const unfinished = jobs.filter((job) => job.status !== 'completed');
  const gate = unfinished[0];
  return unfinished.length === 1 && gate.name === 'CI Gate' && gate.status === 'queued'
    && gate.conclusion === null && gate.started_at === null && gate.completed_at === null
    && Array.isArray(gate.steps) && gate.steps.length === 0
    && jobs.filter((job) => job !== gate).every((job) => TERMINAL.has(job.conclusion)
      && Array.isArray(job.steps) && job.steps.every((step) => step.status === 'completed' && TERMINAL.has(step.conclusion)));
}

export async function recoverSupersededGate({
  env = process.env, fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const target = targetFromEnv(env);
  if (!target) return { outcome: 'held', reason: 'invalid-target' };
  const get = (path) => githubJson(fetchImpl, `${target.base}${path}`, target.token);
  const jobsFor = async (run) => completeList(await get(`/actions/runs/${run.id}/attempts/1/jobs?per_page=100`), 'jobs');
  const held = (reason) => ({ outcome: 'held', reason });

  // A workflow called CI is insufficient: bind to this repository's actual CI file.
  const workflow = await get('/actions/workflows/ci.yml');
  if (workflow?.id !== target.workflowId || workflow.path !== '.github/workflows/ci.yml'
    || workflow.state !== 'active') return held('workflow-unverified');

  async function freshSuccessor() {
    const run = await get(`/actions/runs/${target.id}`);
    if (!boundRun(run, target) || run.id !== target.id || run.head_sha !== target.head
      || !PENDING.has(run.status) || run.conclusion !== null) return null;
    // This read is required even for public repositories; a permission failure
    // is a hold, not authority to expand the workflow's token permissions.
    const pr = await get(`/pulls/${onePr(run)}`);
    if (pr?.number !== onePr(run) || pr.state !== 'open' || pr.base?.repo?.id !== target.repoId
      || pr.head?.sha !== target.head || pr.head.repo?.id !== target.headRepoId
      || pr.head.ref !== run.head_branch) return null;
    const jobs = await jobsFor(run);
    return jobs?.length === 0 ? run : null;
  }

  const successor = await freshSuccessor();
  if (!successor) return held('successor-or-current-head-unverified');
  const runs = completeList(await get(`/actions/workflows/${target.workflowId}/runs?event=pull_request&status=in_progress&per_page=100&branch=${encodeURIComponent(successor.head_branch)}`), 'workflow_runs');
  if (!runs) return held('run-inventory-unverified');
  // Do not silently discard malformed records that could be a competing run.
  if (runs.some((run) => !boundRun(run, target))) return held('run-identity-unverified');
  const candidates = runs.filter((run) => run.id !== target.id && onePr(run) === onePr(successor)
    && run.head_branch === successor.head_branch && run.run_number < successor.run_number
    && run.head_sha !== target.head && run.status === 'in_progress' && run.conclusion === null);
  if (candidates.length !== 1) return held('no-unique-superseded-run');
  const candidate = candidates[0];

  async function inspectOld() {
    const run = await get(`/actions/runs/${candidate.id}`);
    if (!boundRun(run, target) || run.id !== candidate.id || run.head_sha !== candidate.head_sha
      || run.head_branch !== candidate.head_branch || onePr(run) !== onePr(successor)
      || run.run_number !== candidate.run_number) return 'unverified';
    if (completed(run)) return 'settled';
    if (run.status !== 'in_progress' || run.conclusion !== null) return 'unverified';
    return queuedAggregateOnly(await jobsFor(run), run.id) ? 'qualified' : 'unverified';
  }

  // Each mutation has adjacent fresh identity/job and current-head reads.
  if (await inspectOld() !== 'qualified' || !await freshSuccessor()) return held('stale-run-no-longer-qualified');
  async function cancel(kind) {
    try {
      const response = await githubRequest(fetchImpl, `${target.base}/actions/runs/${candidate.id}/${kind}`, target.token, { method: 'POST' });
      return response.status === 202;
    } catch {
      return false; // acceptance is unknown: read back, but never escalate/retry.
    }
  }
  const normalAccepted = await cancel('cancel');
  if (!normalAccepted) {
    const state = await inspectOld();
    return { outcome: state === 'settled' ? 'settled' : 'uncertain', reason: 'normal-cancel-not-confirmed' };
  }
  await sleep(CANCEL_SETTLE_MS);
  const state = await inspectOld();
  if (state === 'settled') return { outcome: 'settled', reason: 'normal-cancel-settled' };
  if (state !== 'qualified' || !await freshSuccessor()) return held('force-cancel-no-longer-qualified');
  const forceAccepted = await cancel('force-cancel');
  const finalState = await inspectOld();
  return {
    outcome: finalState === 'settled' ? 'settled' : forceAccepted && finalState === 'qualified' ? 'pending' : 'uncertain',
    reason: finalState === 'settled' ? 'force-cancel-settled'
      : !forceAccepted ? 'force-cancel-not-confirmed'
        : finalState === 'qualified' ? 'force-cancel-awaiting-settlement' : 'force-cancel-outcome-unverified',
  };
}

if (isDirectlyInvoked(import.meta.url)) {
  const result = await recoverSupersededGate();
  const summary = `Superseded CI aggregate recovery: ${result.outcome} (${result.reason}).`;
  console.log(summary);
  writeStepSummary(`${summary}\n`);
}
