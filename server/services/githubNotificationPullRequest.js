import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { toPgJson } from '../lib/pgJson.js';
import { notificationPullRequestTarget, notificationPullRequestView } from '../lib/githubNotificationPullRequest.js';
import { agentRunPin, pullRequestAutomationFilter, pullRequestAutomationRule } from '../lib/githubNotificationTriage.js';
import { PULL_REQUEST_ACTIONS } from '../../lib/pullRequestActions.js';
import { readGithubPullRequest } from './appPullRequests.js';
import { mergeGithubPullRequest, pullRequestMergeReadiness } from './appPullRequestMerge.js';
import { managedAppsByRepoKey } from './githubNotificationTriage.js';
import { applyNotificationAction, requireAccountEnv } from './githubNotifications.js';
import { githubNotificationEvents } from './githubNotificationEvents.js';
import { githubReviewAccountSelector } from './githubAccounts.js';
import { ON_DEMAND_ORIGINS } from './taskScheduleConstants.js';

const queue = createKeyCachedQueue();
const refuse = (message, code = 'GITHUB_PR_ACTION_REFUSED') => new ServerError(message, { status: 409, code });

async function recordAction(account, row, action, result) {
  const evidence = { action, ...result, at: new Date().toISOString() };
  await withTransaction(async client => {
    await client.query(`UPDATE github_notifications SET
      decision = CASE WHEN $3::boolean THEN 'suggest-mark-read' ELSE 'handed-off' END,
      evidence = evidence || jsonb_build_object('pullRequestAction', $4::jsonb)
        || CASE WHEN $3::boolean THEN '{"subjectState":"merged"}'::jsonb ELSE '{}'::jsonb END,
      updated_at = NOW() WHERE account_id = $1 AND thread_id = $2`,
    [account.id, row.thread_id, result.merged === true, toPgJson(evidence)]);
    await client.query(`INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail)
      VALUES ($1, $2, $3, $4, $5::jsonb)`, [account.id, row.thread_id, result.automatic ? 'automation' : 'operator',
      result.merged ? 'merged' : 'handed-off', toPgJson(evidence)]);
  });
  githubNotificationEvents.emit('changed', { accountId: account.id });
}

/** The button and Autopilot both dispatch through the app PR actions' services. */
export async function actOnNotificationPullRequest(account, threadId, options, { automatic = false, env: suppliedEnv, app: suppliedApp } = {}) {
  const initial = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  if (!initial) throw new ServerError('Notification not found', { status: 404 });
  const target = notificationPullRequestTarget(account, initial);
  if (!target) throw refuse('This notification does not identify a pull request on this account');
  return queue(`${target.repoSpec.toLowerCase()}#${target.number}`, async () => {
    const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
    const currentTarget = notificationPullRequestTarget(account, row);
    if (currentTarget?.repoSpec !== target.repoSpec || currentTarget?.number !== target.number) throw refuse('The notification target changed');
    const view = notificationPullRequestView(account, row);
    const { action } = options;
    if (!view || !PULL_REQUEST_ACTIONS.includes(action)) throw refuse('This notification is no longer actionable');
    const rule = automatic ? pullRequestAutomationRule(account, row) : null;
    if (automatic && rule?.action !== action) throw refuse('This automation rule no longer matches the notification');
    const eligible = { merge: view.mergeEligible, 'do-review': view.doReviewEligible, 'untrusted-review': view.reviewEligible };
    if (!eligible[action]) throw refuse(action === 'merge' ? 'Merge requires a trusted pull-request author' : 'This account or pull request does not allow this review action');

    const env = suppliedEnv || await requireAccountEnv(account);
    const pr = await readGithubPullRequest({ repoSpec: target.repoSpec, number: target.number, env });
    if (!pr) throw refuse('Could not read the current pull request', 'GITHUB_PR_UNAVAILABLE');
    const app = suppliedApp === undefined
      ? (await managedAppsByRepoKey()).get(target.repoSpec.toLowerCase()) || null : suppliedApp;
    let result;
    if (action === 'merge') {
      // A bot badge/title in a notification cannot authorize a different author.
      if (automatic && (!['dependabot[bot]', 'app/dependabot'].includes(pr.author) || !pr.authorIsBot || (!row.evidence?.repoOwned && !app))) {
        throw refuse('Automatic merge requires a verified Dependabot PR in one of your repositories');
      }
      const reason = pullRequestMergeReadiness(pr);
      if (reason) throw refuse(`Pull request is not ready to merge (${reason})`, 'GITHUB_PR_NOT_READY');
      const merge = await mergeGithubPullRequest(pr, { repoSpec: target.repoSpec, env,
        method: options.method, deleteBranch: options.deleteBranch });
      if (!merge.ok) throw refuse(merge.error || 'The forge refused the merge', 'GITHUB_PR_MERGE_FAILED');
      const confirmed = await readGithubPullRequest({ repoSpec: target.repoSpec, number: target.number, env });
      if (confirmed?.state !== 'merged' || confirmed.headSha !== pr.headSha) {
        throw refuse('GitHub has not confirmed the merge of this head; the notification remains open', 'GITHUB_PR_MERGE_UNCONFIRMED');
      }
      result = { merged: true, method: merge.method, deletedBranch: merge.deletedBranch, headSha: pr.headSha };
    } else {
      if (pr.state !== 'open') throw refuse('The pull request is no longer open');
      const pin = agentRunPin({ perRun: ['provider', 'model', 'effort'].some(key => Object.hasOwn(options, key)) ? options : undefined,
        rulePin: rule, defaults: account.agentDefaults });
      if (action === 'do-review') {
        // Recheck discussion trust at the model boundary, including earlier comments.
        const { threadDiscussionVouched } = await import('./githubNotificationTriage.js');
        if (!await threadDiscussionVouched(account, env, row)) throw refuse('This review requires trusted discussion participants; open GitHub to inspect the outside comments');
        const { spawnPrDoReviewTask } = await import('./prDoReviewTask.js');
        const url = `https://${account.host}/${target.repo}/pull/${target.number}`;
        const githubAccount = await githubReviewAccountSelector(account, env);
        const queued = await spawnPrDoReviewTask({ app, pullRequest: { ...pr, url }, repoFullName: target.repo, githubAccount, ...pin, immediate: !automatic,
          notificationAccount: account, notificationOrigin: automatic ? ON_DEMAND_ORIGINS.GITHUB_NOTIFICATION : ON_DEMAND_ORIGINS.USER });
        if (!queued.task) throw refuse('The review could not be queued');
        result = { taskId: queued.task.id, duplicate: queued.duplicate, started: queued.dispatch.started, queueReason: queued.dispatch.reason };
      } else {
        if (!app) throw refuse('Untrusted:Review requires a managed app');
        const { queueTargetedPrReview } = await import('./prReviewerTargetedRun.js');
        const queued = await queueTargetedPrReview(app, target.number, { ...pin,
          origin: automatic ? ON_DEMAND_ORIGINS.GITHUB_NOTIFICATION : ON_DEMAND_ORIGINS.USER });
        result = { taskId: queued.reviewAction?.taskId || null, requestId: queued.request?.id || null, duplicate: queued.duplicate };
      }
    }
    await recordAction(account, row, action, { ...result, appId: app?.id || null, number: target.number, automatic });
    // A merged PR leaves nothing to do on its thread. The merge already happened, so
    // a failed mark-done must not fail the action: the row keeps `suggest-mark-read`
    // and the operator's Mark done button still works.
    if (result.merged) {
      await applyNotificationAction(account.id, row.thread_id, 'done', { actor: automatic ? 'automation' : 'operator', learn: false })
        .catch(err => console.warn(`⚠️ Merged PR #${target.number} but could not mark its notification done: ${err.message}`));
    }
    return result;
  });
}

/** Pending CI is checked again on the next scheduled run, even without thread activity. */
export async function automateNotificationPullRequests(account, env) {
  if (account.mode !== 'autopilot') return { merged: 0, reviews: 0 };
  const filter = pullRequestAutomationFilter(account.agentRules);
  const { rows } = await query(`SELECT * FROM github_notifications WHERE account_id = $1 AND state = 'open' AND NOT suspect
    AND subject_type = 'PullRequest' AND COALESCE(decision, '') <> 'handed-off'
    AND COALESCE(evidence->>'subjectState', '') NOT IN ('closed', 'merged')
    AND (${filter.sql}) ORDER BY (evidence->'pullRequestAttempt'->>'at')::timestamptz ASC NULLS FIRST, gh_updated_at DESC LIMIT 50`,
  [account.id, ...filter.params]);
  const counts = { merged: 0, reviews: 0 };
  for (const row of rows) {
    const rule = pullRequestAutomationRule(account, row);
    if (!rule) continue;
    const result = await actOnNotificationPullRequest(account, row.thread_id, { action: rule.action,
      method: rule.mergeMethod, deleteBranch: rule.deleteBranch }, { automatic: true, env })
      .catch(error => ({ refused: error.code || 'GITHUB_PR_ACTION_FAILED' }));
    if (result.refused) {
      // Keep the reason bounded and visible; no raw forge output or thread text.
      await query(`UPDATE github_notifications SET evidence = evidence || jsonb_build_object('pullRequestAttempt', $3::jsonb)
        WHERE account_id = $1 AND thread_id = $2`, [account.id, row.thread_id, toPgJson({ action: rule.action, reason: result.refused, at: new Date().toISOString() })]);
    } else counts[result.merged ? 'merged' : 'reviews'] += 1;
  }
  return counts;
}
