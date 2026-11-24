import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { getSlashdoWorkflow } from '../lib/slashdoCatalog.js';
import { notificationAgentAccountBinding } from '../lib/githubNotificationTriage.js';
import { notificationIssueClaimTarget } from '../lib/githubNotificationIssue.js';
import { githubReviewAccountSelector } from './githubAccounts.js';
import { requireAccountEnv } from './githubNotifications.js';
import { managedAppsByRepoKey, threadDiscussionVouched } from './githubNotificationTriage.js';
import { buildManualClaimTask } from './cos/manualClaimTask.js';

const queue = createKeyCachedQueue();
const refused = message => new ServerError(message, { status: 409, code: 'GITHUB_ISSUE_CLAIM_REFUSED' });

/** Operator-only Inbox action. Uses the same pinned manual claim as the app Issues tab. */
export async function claimNotificationIssue(account, threadId, pin) {
  return queue(`${account.id}/${threadId}`, async () => {
    const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
    if (!row) throw new ServerError('Notification not found', { status: 404, code: 'GITHUB_NOTIFICATION_NOT_FOUND' });
    const target = notificationIssueClaimTarget(account, row);
    if (!target) throw refused('Only a trusted, open issue in a managed GitHub repository can be claimed here');
    const app = (await managedAppsByRepoKey()).get(`${target.host}/${target.repo}`.toLowerCase());
    if (!app) throw refused('No PortOS app currently manages this repository');

    const env = await requireAccountEnv(account);
    const selector = await githubReviewAccountSelector(account, env);
    if (!await threadDiscussionVouched(account, env, row)) {
      throw refused('This issue has unverified discussion participants. Review it in GitHub before taking action.');
    }
    const shape = await buildManualClaimTask(app, getSlashdoWorkflow('next'), { target: String(target.number) }, {
      expectedGithubIssue: { ...target, login: selector.login },
    });
    const { addTask } = await import('./cos/cosTaskStore.js');
    const task = await addTask({
      description: shape.description,
      app: app.id,
      prompt: shape.prompt,
      metadata: {
        prompt: shape.prompt,
        githubAccount: selector,
        githubIssueClaim: target,
        githubNotificationAccount: notificationAgentAccountBinding(account),
      },
      ...shape.taskMetadata,
      ...pin,
      reviewLoop: false,
    }, 'user');
    if (!task?.id) throw refused('The claim task could not be queued');
    return { taskId: task.id, duplicate: task.duplicate === true };
  });
}
