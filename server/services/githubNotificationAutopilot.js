/**
 * Autopilot mode for the GitHub notifications inbox (#12874). After triage and
 * Assist, a thread in one of the operator's managed apps is handed to the lane
 * that already owns that work: a review request from an outside author to
 * `pr-reviewer` (the same targeted run as the Pull Requests tab's
 * Untrusted:Review button), outside issue activity to `issue-watcher`, and a
 * security alert to `dependency-updates`. A security alert in a repo of yours
 * that no app manages, or a global advisory, goes to a one-off `security-fix`
 * task (githubSecurityFixTask.js). Any other review request goes to a
 * review-only `/do:review` run (prDoReviewTask.js) once an agent rule switches
 * review requests on for its repo. The account's agent rules also switch a kind
 * off for a repo, and pin each run's provider/model/effort (else the account's
 * agent defaults). The inbox's Resolve with agent button hands one thread off
 * the same way on a tap, in any mode; a thread no specific lane fits goes on a
 * tap to a generic `notification-resolve` run (githubNotificationResolveTask.js),
 * which Autopilot never starts on its own.
 *
 * Nothing here reads thread text: each hand-off queues the lane's own run,
 * which re-screens its input with its own guards. The on-demand origin is
 * automated, so a per-app lane must be switched on for that app. Mentions in
 * repos the operator does not own are never handed off.
 */
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { advisoryIdFromUrl } from '../lib/githubNotificationParse.js';
import { agentHandoff, agentRuleScope, agentRunPin, APP_FREE_AGENT_LANES as APP_FREE_LANES, autopilotHandoff, GENERIC_AGENT_LANE } from '../lib/githubNotificationTriage.js';
import { toPgJson } from '../lib/pgJson.js';
import { managedAppsByRepoKey, threadDiscussionVouched } from './githubNotificationTriage.js';
import { requireAccountEnv } from './githubNotifications.js';
import { queueNotificationResolveTask } from './githubNotificationResolveTask.js';
import { queueSecurityFixTask } from './githubSecurityFixTask.js';
import { spawnPrDoReviewTask } from './prDoReviewTask.js';
import { queueTargetedPrReview, readActiveTasks, readPendingOnDemandRequests, ACTIVE_TASK_STATUSES } from './prReviewerTargetedRun.js';
import { triggerOnDemandTask } from './taskSchedule.js';
import { ON_DEMAND_ORIGINS } from './taskScheduleConstants.js';

// Threads per run, not agent runs: a run queues at most one agent per repo and lane.
const MAX_HANDOFFS_PER_RUN = 50;
// The SQL mirror of `agentHandoff`'s lane rules and the account's agent
// rules, so a run's limit is spent only on threads that can be handed off and
// an older eligible thread is never starved by newer ones the rules would
// reject. `inScope(n)` reads one `agentRuleScope` as parameters $n..$n+2.
const inScope = (n) => `(($${n}::boolean AND NOT (lower(repo_full_name) = ANY($${n + 1}::text[]))) OR lower(repo_full_name) = ANY($${n + 2}::text[]))`;
export const CANDIDATE_SQL = `((reason = 'review_requested' AND subject_type = 'PullRequest' AND COALESCE(evidence->>'subjectState', '') NOT IN ('merged', 'closed') AND (
      (decision = 'suggest-untrusted-review' AND COALESCE(trust, '') NOT IN ('yours', 'trusted') AND (evidence->>'repoManaged')::boolean IS TRUE AND ${inScope(2)})
      OR (decision IN ('suggest-review', 'suggest-untrusted-review', 'needs-you', 'surface') AND trust IN ('yours', 'trusted') AND ${inScope(5)})))
  OR (subject_type = 'Issue' AND decision IN ('needs-you', 'surface')
    AND (trust = 'outside' OR (evidence->>'commenter' IS NOT NULL AND COALESCE(evidence->>'commenterTrust', '') NOT IN ('yours', 'trusted')))
    AND (evidence->>'repoManaged')::boolean IS TRUE AND ${inScope(8)})
  OR (reason = 'security_alert' AND decision = 'surface-high' AND ${inScope(11)}))`;
const scopeParams = ({ all, except, only }) => [all, except, only];

/**
 * Queue the app's run of a whole-app lane unless one is already queued or
 * running. For pr-reviewer this is the sweep over every outside PR, so a run
 * narrowed to one PR does not count as one.
 */
async function queueAppLane(taskType, app, origin, pin) {
  const covers = (target) => target === undefined || target === null;
  const [tasks, requests] = await Promise.all([readActiveTasks(), readPendingOnDemandRequests()]);
  // Unreadable state is not "nothing queued": fail closed rather than queue a
  // second pass over the same work.
  if (tasks === null || requests === null) return { error: 'Could not inspect existing CoS actions' };
  const running = tasks.find((task) => ACTIVE_TASK_STATUSES.has(task?.status)
    && task.metadata?.analysisType === taskType && task.metadata?.app === app.id && covers(task.metadata?.targetPullRequest));
  if (running) return { duplicate: true, taskId: running.id };
  if (requests.some((request) => request?.taskType === taskType && request?.appId === app.id && covers(request?.targetPullRequest))) return { duplicate: true };
  const request = await triggerOnDemandTask(taskType, app.id, { origin, ...pin });
  return request?.error ? { error: request.error } : { requestId: request.id };
}

async function queueLane(plan, app, origin, { account, rows, immediate = false }) {
  const pin = plan.pin || {};
  if (plan.lane === 'security-fix') {
    const advisories = plan.repo ? [] : rows.map((row) => advisoryIdFromUrl(row.subject_api_url, account.host)).filter(Boolean);
    return queueSecurityFixTask({ account, repo: plan.repo || null, advisories, origin, ...pin });
  }
  if (plan.lane === GENERIC_AGENT_LANE) return queueNotificationResolveTask({ account, row: rows[0], origin, ...pin });
  if (plan.lane === 'do-review') {
    // The stored html url is rebuilt from GitHub's own API url on the account's host.
    const url = rows[0]?.html_url || '';
    if (!url.endsWith(`/pull/${plan.pullNumber}`)) return { error: 'No pull request link for this notification' };
    const queued = await spawnPrDoReviewTask({ app, pullRequest: { number: plan.pullNumber, url }, repoFullName: plan.repo, ...pin, immediate });
    if (!queued.task) return { error: 'The review could not be queued' };
    return queued.duplicate ? { duplicate: true, taskId: queued.task.id } : { taskId: queued.task.id };
  }
  if (plan.lane !== 'pr-reviewer' || !plan.pullNumber) return queueAppLane(plan.lane, app, origin, pin);
  return queueTargetedPrReview(app, plan.pullNumber, { origin, ...pin })
    .then((queued) => (queued.duplicate ? { duplicate: true, taskId: queued.reviewAction?.taskId || null } : { requestId: queued.request.id }));
}

// The rule's pin, else the account's agent defaults (#13191), else CoS's own choice.
function withRunPin(account, plan, perRun) {
  if (!plan) return plan;
  const { pin: rulePin, ...rest } = plan;
  const pin = agentRunPin({ perRun, rulePin, defaults: account.agentDefaults });
  return Object.keys(pin).length ? { ...rest, pin } : rest;
}

async function recordHandoff(account, row, handoff, actor = 'automation') {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE github_notifications SET decision = CASE WHEN $3::boolean THEN 'handed-off' ELSE decision END,
         evidence = evidence || jsonb_build_object('handoff', $4::jsonb), updated_at = NOW()
       WHERE account_id = $1 AND thread_id = $2`,
      [account.id, row.thread_id, !handoff.skipped, toPgJson(handoff)],
    );
    if (!handoff.skipped) {
      await client.query(
        `INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, $3, 'handed-off', $4::jsonb)`,
        [account.id, row.thread_id, actor, toPgJson({ lane: handoff.lane, appId: handoff.appId, previousDecision: row.decision })],
      );
    }
  });
}

/**
 * Hand off this account's eligible threads, batched so one agent run covers
 * every thread of a lane in a repo: a dozen alerts for one repo queue one
 * dependency-updates run, and review requests on several outside PRs in one
 * repo queue one pr-reviewer sweep instead of one targeted run each. Each
 * thread is tried once per activity: a refusal is recorded with its reason and
 * the thread stays with you until new activity re-triages it.
 */
export async function autopilotAccountNotifications(account) {
  if (account.mode !== 'autopilot') return { handedOff: 0, agentRuns: 0 };
  const rules = account.agentRules;
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = $1 AND state = 'open' AND NOT suspect
       AND ${CANDIDATE_SQL} AND NOT (evidence ? 'handoff')
     ORDER BY gh_updated_at DESC LIMIT ${MAX_HANDOFFS_PER_RUN}`,
    [
      account.id,
      ...scopeParams(agentRuleScope(rules, 'review-request')),
      ...scopeParams(agentRuleScope(rules, 'review-request', { optIn: true })),
      ...scopeParams(agentRuleScope(rules, 'issue-activity')),
      ...scopeParams(agentRuleScope(rules, 'security-alert')),
    ],
  );
  const plans = rows.map((row) => ({ row, plan: withRunPin(account, autopilotHandoff({ account, row })) })).filter((entry) => entry.plan);
  if (!plans.length) return { handedOff: 0, agentRuns: 0 };
  const apps = await managedAppsByRepoKey();
  const batches = new Map();
  const skipped = [];
  for (const entry of plans) {
    const app = apps.get(`${account.host}/${entry.row.repo_full_name}`.toLowerCase()) || null;
    if (!entry.plan.refused && APP_FREE_LANES.has(entry.plan.lane)) {
      // A security fix runs once per repo, and once for every global advisory
      // together; a review runs once per pull request.
      const target = entry.plan.lane === 'do-review' ? `${entry.row.repo_full_name}#${entry.plan.pullNumber}` : entry.plan.repo || '*';
      const key = `${entry.plan.lane}#${target}`;
      if (!batches.has(key)) batches.set(key, { app, lane: entry.plan.lane, repo: entry.plan.repo, plan: entry.plan, entries: [] });
      batches.get(key).entries.push({ ...entry, app });
      continue;
    }
    if (entry.plan.refused || !app) {
      skipped.push({ ...entry, app, outcome: { skipped: entry.plan.refused || 'no-managed-app' } });
      continue;
    }
    const key = `${app.id}#${entry.plan.lane}`;
    if (!batches.has(key)) batches.set(key, { app, lane: entry.plan.lane, plan: entry.plan, entries: [] });
    batches.get(key).entries.push({ ...entry, app });
  }

  let handedOff = 0;
  let agentRuns = 0;
  const record = async ({ row, plan, app, outcome }) => {
    const handoff = {
      lane: plan.lane,
      appId: app?.id || null,
      appName: app?.name || null,
      ...(plan.pullNumber ? { pullNumber: plan.pullNumber } : {}),
      ...(plan.pin ? { pin: plan.pin } : {}),
      ...outcome,
      at: new Date().toISOString(),
    };
    await recordHandoff(account, row, handoff);
    if (handoff.skipped) {
      console.log(`⏭️ Autopilot left GitHub notification ${row.thread_id} with you: ${handoff.skipped}${handoff.error ? ` (${handoff.error})` : ''}`);
    } else {
      handedOff += 1;
    }
  };
  for (const entry of skipped) await record(entry);
  for (const { app, lane, repo, plan, entries } of batches.values()) {
    const pullNumbers = new Set(entries.map((entry) => entry.plan.pullNumber).filter(Boolean));
    // One rule covers a batch (same repo and kind), so its pin is shared.
    const batchPlan = lane === 'do-review' || (lane === 'pr-reviewer' && pullNumbers.size === 1)
      ? plan
      : { lane, repo, ...(plan.pin ? { pin: plan.pin } : {}) };
    // A lane that throws (a schedule write failing) is a recorded skip, so
    // it never stops Assist or the rest of the sync for this account.
    const queued = await queueLane(batchPlan, app, ON_DEMAND_ORIGINS.GITHUB_NOTIFICATION, { account, rows: entries.map((entry) => entry.row) })
      .catch((error) => ({ error: error.message }));
    const outcome = queued.error
      ? { skipped: 'lane-unavailable', error: String(queued.error).slice(0, 300) }
      : { ...queued, ...(entries.length > 1 ? { batchSize: entries.length } : {}) };
    if (!queued.error && !queued.duplicate) agentRuns += 1;
    for (const entry of entries) await record({ ...entry, outcome });
    if (!queued.error) console.log(`🤝 Autopilot handed ${entries.length} GitHub notification(s) to one ${lane} run for ${app?.name || repo || 'your repositories'}`);
  }
  return { handedOff, agentRuns };
}

const REFUSED_MESSAGES = {
  'private-account': 'Private accounts never hand threads to an agent: the agents use their own AI providers',
  'no-managed-app': 'No PortOS app manages this repo, so no agent can work on it',
  'outside-content': 'Outside content goes only to the screened Untrusted:Review and issue watcher lanes',
  'comment-unchecked': 'The latest comment has not been checked yet; new activity re-checks it',
  'deployment-approval': 'Only you can approve or reject a deployment',
  invitation: 'Only you can accept or decline an invitation',
  'security-alert': 'Security alerts go only to their dependency update or security fix agents',
  finished: 'Nothing is left to do on this thread',
  'handed-off': 'An agent already has this thread',
  'no-repo': 'This notification names no repository for an agent to work in',
};

/**
 * The inbox's Resolve with agent tap: hand one thread to its lane now, in any
 * mode, under the same rules as Autopilot, on the operator's per-run
 * provider/model/effort when given. A refusal or a lane that will not take it
 * is an error for the tap and leaves the thread as it was.
 */
export async function handOffThread(account, threadId, perRun) {
  const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  if (!row) throw new ServerError('Notification not found', { status: 404, code: 'GITHUB_NOTIFICATION_NOT_FOUND' });
  if (row.state === 'open' && row.suspect) throw new ServerError('Suspect threads never go to an agent', { status: 409, code: 'GITHUB_NOTIFICATION_HANDOFF_REFUSED' });
  const plan = withRunPin(account, agentHandoff({ account, row }), perRun);
  if (!plan) throw new ServerError('No agent handles this kind of notification', { status: 409, code: 'GITHUB_NOTIFICATION_NO_LANE' });
  if (plan.refused) throw new ServerError(REFUSED_MESSAGES[plan.refused] || 'No agent may take this thread', { status: 409, code: 'GITHUB_NOTIFICATION_HANDOFF_REFUSED' });
  const app = (await managedAppsByRepoKey()).get(`${account.host}/${row.repo_full_name}`.toLowerCase()) || null;
  if (!APP_FREE_LANES.has(plan.lane) && !app) throw new ServerError(REFUSED_MESSAGES['no-managed-app'], { status: 409, code: 'GITHUB_NOTIFICATION_HANDOFF_REFUSED' });
  // The generic run reads the whole thread, not just the latest comment triage rated.
  if (plan.lane === GENERIC_AGENT_LANE && !(await threadDiscussionVouched(account, await requireAccountEnv(account), row))) {
    throw new ServerError(REFUSED_MESSAGES['outside-content'], { status: 409, code: 'GITHUB_NOTIFICATION_HANDOFF_REFUSED' });
  }
  const queued = await queueLane(plan, app, ON_DEMAND_ORIGINS.USER, { account, rows: [row], immediate: true });
  if (queued.error) throw new ServerError(String(queued.error), { status: 409, code: 'GITHUB_NOTIFICATION_LANE_UNAVAILABLE' });
  await recordHandoff(account, row, {
    lane: plan.lane,
    appId: app?.id || null,
    appName: app?.name || null,
    ...(plan.pullNumber ? { pullNumber: plan.pullNumber } : {}),
    ...(plan.pin ? { pin: plan.pin } : {}),
    // A failed generic run restores it (githubNotificationResolveTask.js).
    previousDecision: row.decision || null,
    ...queued,
    at: new Date().toISOString(),
  }, 'operator');
  console.log(`🤝 Handed GitHub notification ${row.thread_id} to ${plan.lane} for ${app?.name || row.repo_full_name || 'your repositories'}`);
}
