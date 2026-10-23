/**
 * Deployment approvals from the GitHub notifications inbox (#13198): read the
 * environments a waiting workflow run is blocked on, and approve or reject
 * them as the operator.
 *
 * Operator only. Approving can ship to production, so nothing in Assist,
 * Autopilot, an agent rule or an agent lane calls this module; the route is
 * host-control gated. The run comes from triage's forge read
 * (`evidence.workflowRun`), never from a title, and the environments sent are
 * re-checked against the run's pending list at the moment of the tap.
 */
import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { toPgJson } from '../lib/pgJson.js';
import { execGh } from './github.js';
import { getAccount } from './githubAccounts.js';
import { applyNotificationAction, getNotification, requireAccountEnv } from './githubNotifications.js';

const GH_TIMEOUT_MS = 30_000;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PENDING_JQ = '[.[] | {environmentId: .environment.id, name: .environment.name, canApprove: (.current_user_can_approve == true), waitTimer: (.wait_timer // 0), reviewers: [.reviewers[]? | (.reviewer.login // .reviewer.slug // .reviewer.name // empty)]}]';

async function loadRun(accountId, threadId) {
  const account = await getAccount(accountId);
  const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  if (!row) throw new ServerError('Notification not found', { status: 404, code: 'GITHUB_NOTIFICATION_NOT_FOUND' });
  const runId = row.evidence?.workflowRun?.id;
  if (row.reason !== 'approval_requested' || !Number.isInteger(runId) || runId <= 0 || !REPO_RE.test(row.repo_full_name)) {
    throw new ServerError('This notification is not a deployment waiting for approval', { status: 409, code: 'GITHUB_NOTIFICATION_NOT_DEPLOYMENT' });
  }
  return { account, row, runId, path: `repos/${row.repo_full_name}/actions/runs/${runId}/pending_deployments` };
}

async function readPending(account, env, path) {
  const out = await execGh(['api', '--hostname', account.host, '--method', 'GET', path, '--jq', PENDING_JQ], GH_TIMEOUT_MS, { env });
  const environments = safeJSONParse(out, null, { logError: false });
  if (!Array.isArray(environments)) {
    throw new ServerError('GitHub returned an unreadable list of pending deployments', { status: 502, code: 'GITHUB_DEPLOYMENTS_UNPARSEABLE' });
  }
  return environments.filter((entry) => Number.isInteger(entry?.environmentId) && entry.environmentId > 0).map((entry) => ({
    environmentId: entry.environmentId,
    name: String(entry.name || '').slice(0, 255),
    canApprove: entry.canApprove === true,
    waitTimer: Number.isInteger(entry.waitTimer) ? entry.waitTimer : 0,
    reviewers: Array.isArray(entry.reviewers) ? entry.reviewers.filter((name) => typeof name === 'string').slice(0, 20) : [],
  }));
}

/** The run and the environments it waits on; empty once nothing is waiting. */
export async function getDeploymentReview(accountId, threadId) {
  const { account, path, runId } = await loadRun(accountId, threadId);
  const env = await requireAccountEnv(account);
  return { runId, environments: await readPending(account, env, path) };
}

/**
 * Approve or reject the chosen environments, then mark the thread done
 * without teaching a learned rule. Every id must still be pending and one
 * the operator can approve; otherwise nothing is sent.
 */
export async function reviewDeployment(accountId, threadId, { state, environmentIds, comment = '' }) {
  const { account, row, path, runId } = await loadRun(accountId, threadId);
  const env = await requireAccountEnv(account);
  const pending = new Map((await readPending(account, env, path)).map((entry) => [entry.environmentId, entry]));
  const ids = [...new Set(environmentIds)];
  const refused = ids.filter((id) => !pending.get(id)?.canApprove);
  if (refused.length) {
    throw new ServerError('Those environments are no longer waiting on you; reload the deployment', { status: 409, code: 'GITHUB_DEPLOYMENT_NOT_PENDING' });
  }
  await execGh([
    'api', '--hostname', account.host, '--method', 'POST', path,
    ...ids.flatMap((id) => ['-F', `environment_ids[]=${id}`]),
    '-f', `state=${state}`, '-f', `comment=${comment}`,
  ], GH_TIMEOUT_MS, { env });
  const environments = ids.map((id) => pending.get(id).name);
  await query(
    'INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, \'operator\', $3, $4::jsonb)',
    [account.id, row.thread_id, state === 'approved' ? 'deployment-approved' : 'deployment-rejected', toPgJson({ runId, environments })],
  );
  console.log(`🚦 ${state === 'approved' ? 'Approved' : 'Rejected'} deployment of run ${runId} to ${environments.join(', ')} in ${row.repo_full_name}`);
  await applyNotificationAction(account.id, row.thread_id, 'done', { learn: false, detail: { deployment: state, runId } });
  return getNotification(account.id, row.thread_id);
}
