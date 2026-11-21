/**
 * Verifies from GitHub Actions evidence that the repository's Main health
 * workflow closed a "main is red" incident after a green default-branch CI run.
 *
 * The closing actor (the shared `github-actions` bot), the title, labels and the
 * recovery line are only pointers: any workflow in the repository acts as that
 * bot. Authority comes from the Actions API, which outside contributors cannot
 * forge: the named CI run is a successful push/scheduled `ci.yml` run on the
 * default branch whose commit the live default head contains, and the closure
 * happened while the Main health report job for that same commit was running
 * and that job succeeded. Every missing or mismatched piece fails closed.
 *
 * Writer side: scripts/ci-nightly-report.js (`MAIN_RED_TITLE`,
 * `mainHealthRecoveryLine`) run by .github/workflows/main-health.yml.
 */
import { safeJSONParse } from '../lib/fileUtils.js';

const ACTIONS_BOT = 'github-actions';
const MAIN_RED_TITLE = 'main is red';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const MONITOR_WORKFLOW = '.github/workflows/main-health.yml';
const MONITOR_JOB = 'Update the main-is-red issue';
const CI_EVENTS = new Set(['push', 'schedule']);
const RECOVERY_LINE = /^Green again at `([0-9a-f]{7,40})`: https:\/\/([a-z0-9.-]+)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d{0,19})$/;
const FULL_SHA = /^[a-f0-9]{40,64}$/i;

const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const workflowPath = run => typeof run?.path === 'string' ? run.path.split('@', 1)[0] : null;
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const isActionsBot = user => user?.type === 'Bot' && sameText(user.login, `${ACTIONS_BOT}[bot]`);

function inRepository(run, fullName, defaultBranch) {
  return sameText(run?.repository?.full_name, fullName) && sameText(run?.head_repository?.full_name, fullName)
    && run.head_branch === defaultBranch && FULL_SHA.test(run.head_sha || '');
}

/** The last non-empty body line, which the closing write appends. */
function recoveryPointer(body, target) {
  const last = String(body ?? '').split('\n').map(line => line.trim()).filter(Boolean).at(-1) || '';
  const match = RECOVERY_LINE.exec(last);
  if (!match || !sameText(match[2], target.webHost) || !sameText(match[3], target.fullName)) return null;
  const runId = Number(match[4]);
  return Number.isSafeInteger(runId) ? { shortSha: match[1].toLowerCase(), runId } : null;
}

/**
 * @param {object} input
 * @param {number} input.number - the selected issue
 * @param {{fullName: string, apiHost: string, webHost: string}} input.target
 * @param {(args: string[]) => Promise<string>} input.run - read-only `gh` runner
 * @param {{actor?: {login?: string}, createdAt: string}} input.closed - latest ClosedEvent
 * @param {string} input.defaultBranch
 * @param {string} input.defaultCommit - live default-branch head
 * @returns {Promise<{verified: true, ciRun: number, ciCommit: string, monitorRun: number}|{verified: false, reason: string}>}
 */
export async function verifyMainHealthClosure({ number, target, run, closed, defaultBranch, defaultCommit }) {
  const refuse = reason => ({ verified: false, reason });
  const read = async endpoint => safeJSONParse(await run(['api', '--hostname', target.apiHost, '--method', 'GET', endpoint])
    .catch(() => null), null, { logError: false });
  const closedAt = time(closed?.createdAt);
  if (!sameText(closed?.actor?.login, ACTIONS_BOT) || !Number.isFinite(closedAt)) return refuse('main-health-closure-unverified');
  if (typeof defaultBranch !== 'string' || !defaultBranch || !FULL_SHA.test(defaultCommit || '')) {
    return refuse('default-branch-unavailable');
  }
  const repo = `repos/${target.fullName}`;

  const issue = await read(`${repo}/issues/${number}`);
  if (issue?.number !== number || issue.pull_request || issue.state !== 'closed' || issue.state_reason !== 'completed'
    || issue.title !== MAIN_RED_TITLE || !isActionsBot(issue.user) || !isActionsBot(issue.closed_by)
    || time(issue.closed_at) !== closedAt) return refuse('main-health-incident-unverified');
  const pointer = recoveryPointer(issue.body, target);
  if (!pointer) return refuse('main-health-incident-unverified');

  const ci = await read(`${repo}/actions/runs/${pointer.runId}`);
  if (ci?.id !== pointer.runId || workflowPath(ci) !== CI_WORKFLOW || !CI_EVENTS.has(ci.event)
    || !inRepository(ci, target.fullName, defaultBranch) || !ci.head_sha.toLowerCase().startsWith(pointer.shortSha)
    || ci.status !== 'completed' || ci.conclusion !== 'success' || !(time(ci.run_started_at) <= closedAt)) {
    return refuse('main-health-ci-run-unverified');
  }
  // A green run of a commit later force-pushed away proves nothing about main.
  const contained = await read(`${repo}/compare/${ci.head_sha}...${defaultCommit}`);
  if (!['ahead', 'identical'].includes(contained?.status)) return refuse('main-health-ci-run-unverified');

  // Main health runs share one concurrency group, so at most one report job is
  // writing at any instant; a second window containing the closure is ambiguous.
  const monitors = await read(`${repo}/actions/workflows/main-health.yml/runs?head_sha=${ci.head_sha}&event=workflow_run&per_page=100`);
  const monitorRuns = monitors?.workflow_runs;
  if (!Array.isArray(monitorRuns) || monitors.total_count !== monitorRuns.length) return refuse('main-health-run-unverified');
  const writers = [];
  for (const monitor of monitorRuns) {
    if (!Number.isSafeInteger(monitor?.id) || workflowPath(monitor) !== MONITOR_WORKFLOW || monitor.event !== 'workflow_run'
      || !inRepository(monitor, target.fullName, defaultBranch) || monitor.head_sha !== ci.head_sha
      || !(time(monitor.created_at) <= closedAt) || time(monitor.created_at) < time(ci.run_started_at)) continue;
    const jobs = await read(`${repo}/actions/runs/${monitor.id}/jobs?filter=all&per_page=100`);
    if (!Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length) return refuse('main-health-run-unverified');
    for (const job of jobs.jobs) {
      if (job?.run_id === monitor.id && job.name === MONITOR_JOB && job.head_sha === ci.head_sha
        && job.status === 'completed' && job.conclusion === 'success'
        && time(job.started_at) <= closedAt && closedAt <= time(job.completed_at)) writers.push(monitor.id);
    }
  }
  if (writers.length !== 1) return refuse('main-health-run-unverified');
  return { verified: true, ciRun: ci.id, ciCommit: ci.head_sha, monitorRun: writers[0] };
}
