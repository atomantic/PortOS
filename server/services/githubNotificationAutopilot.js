/**
 * Autopilot mode for the GitHub notifications inbox (#12874). After triage and
 * Assist, a thread in one of the operator's managed apps is handed to the lane
 * that already owns that work: a review request from an outside author to
 * `pr-reviewer` (the same targeted run as the Pull Requests tab's
 * Untrusted:Review button), and outside issue activity to `issue-watcher`.
 *
 * Nothing here reads thread text or starts an agent: each hand-off queues the
 * lane's own on-demand run, which re-screens its input with its own guards. The
 * on-demand origin is automated, so the lane must be switched on for that app.
 * Mentions or requests in repos the operator does not own are never handed off.
 */
import { query, withTransaction } from '../lib/db.js';
import { autopilotHandoff } from '../lib/githubNotificationTriage.js';
import { toPgJson } from '../lib/pgJson.js';
import { managedAppsByRepoKey } from './githubNotificationTriage.js';
import { queueTargetedPrReview, readActiveTasks, readPendingOnDemandRequests, ACTIVE_TASK_STATUSES } from './prReviewerTargetedRun.js';
import { triggerOnDemandTask } from './taskSchedule.js';
import { ON_DEMAND_ORIGINS } from './taskScheduleConstants.js';

const MAX_HANDOFFS_PER_RUN = 10;
const ISSUE_WATCHER_TASK_TYPE = 'issue-watcher';
const CANDIDATE_DECISIONS = ['suggest-untrusted-review', 'needs-you', 'surface'];

/** Queue the app's issue-watcher run unless one is already queued or running. */
async function queueIssueWatcher(app) {
  const [tasks, requests] = await Promise.all([readActiveTasks(), readPendingOnDemandRequests()]);
  // Unreadable state is not "nothing queued": fail closed rather than queue a
  // second screening pass over the same issues.
  if (tasks === null || requests === null) return { error: 'Could not inspect existing CoS actions' };
  const running = tasks.find((task) => ACTIVE_TASK_STATUSES.has(task?.status)
    && task.metadata?.analysisType === ISSUE_WATCHER_TASK_TYPE && task.metadata?.app === app.id);
  if (running) return { duplicate: true, taskId: running.id };
  if (requests.some((request) => request?.taskType === ISSUE_WATCHER_TASK_TYPE && request?.appId === app.id)) return { duplicate: true };
  const request = await triggerOnDemandTask(ISSUE_WATCHER_TASK_TYPE, app.id, { origin: ON_DEMAND_ORIGINS.GITHUB_NOTIFICATION });
  return request?.error ? { error: request.error } : { requestId: request.id };
}

async function queueLane(plan, app) {
  if (plan.lane === 'issue-watcher') return queueIssueWatcher(app);
  return queueTargetedPrReview(app, plan.pullNumber, { origin: ON_DEMAND_ORIGINS.GITHUB_NOTIFICATION })
    .then((queued) => (queued.duplicate ? { duplicate: true, taskId: queued.reviewAction?.taskId || null } : { requestId: queued.request.id }))
    .catch((error) => ({ error: error.message }));
}

async function recordHandoff(account, row, handoff) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE github_notifications SET decision = CASE WHEN $3::boolean THEN 'handed-off' ELSE decision END,
         evidence = evidence || jsonb_build_object('handoff', $4::jsonb), updated_at = NOW()
       WHERE account_id = $1 AND thread_id = $2`,
      [account.id, row.thread_id, !handoff.skipped, toPgJson(handoff)],
    );
    if (!handoff.skipped) {
      await client.query(
        `INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, 'automation', 'handed-off', $3::jsonb)`,
        [account.id, row.thread_id, toPgJson({ lane: handoff.lane, appId: handoff.appId, previousDecision: row.decision })],
      );
    }
  });
}

/**
 * Hand off this account's eligible threads. Each thread is tried once per
 * activity: a refusal is recorded with its reason and the thread stays with
 * you until new activity re-triages it.
 */
export async function autopilotAccountNotifications(account) {
  if (account.mode !== 'autopilot') return { handedOff: 0 };
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = $1 AND state = 'open' AND NOT suspect
       AND decision = ANY($2::text[]) AND (evidence->>'repoManaged')::boolean IS TRUE AND NOT (evidence ? 'handoff')
     ORDER BY gh_updated_at DESC LIMIT ${MAX_HANDOFFS_PER_RUN}`,
    [account.id, CANDIDATE_DECISIONS],
  );
  const plans = rows.map((row) => ({ row, plan: autopilotHandoff({ account, row }) })).filter((entry) => entry.plan);
  if (!plans.length) return { handedOff: 0 };
  const apps = await managedAppsByRepoKey();
  let handedOff = 0;
  for (const { row, plan } of plans) {
    const app = apps.get(`${account.host}/${row.repo_full_name}`.toLowerCase());
    let outcome;
    if (plan.refused) outcome = { skipped: plan.refused };
    else if (!app) outcome = { skipped: 'no-managed-app' };
    else {
      const queued = await queueLane(plan, app);
      outcome = queued.error ? { skipped: 'lane-unavailable', error: String(queued.error).slice(0, 300) } : queued;
    }
    const handoff = {
      lane: plan.lane,
      appId: app?.id || null,
      appName: app?.name || null,
      ...(plan.pullNumber ? { pullNumber: plan.pullNumber } : {}),
      ...outcome,
      at: new Date().toISOString(),
    };
    await recordHandoff(account, row, handoff);
    if (handoff.skipped) {
      console.log(`⏭️ Autopilot left GitHub notification ${row.thread_id} with you: ${handoff.skipped}${handoff.error ? ` (${handoff.error})` : ''}`);
    } else {
      handedOff += 1;
      console.log(`🤝 Autopilot handed GitHub notification ${row.thread_id} to ${plan.lane} for ${app.name}`);
    }
  }
  return { handedOff };
}
