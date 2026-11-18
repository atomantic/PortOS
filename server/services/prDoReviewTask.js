/**
 * Queue the bundled `/do:review` workflow against ONE open pull request: the
 * install's review roster pointed at any open GitHub PR, delivering an inline
 * review and nothing else.
 *
 *  - **Review only.** The invocation carries `--no-apply`. slashdo's default
 *    (`auto`) would `gh pr checkout` the head branch in the app's LIVE checkout
 *    (a report-shaped workflow gets no worktree) and switch it out from under
 *    whoever is working there.
 *  - **Reviewers are NOT resolved here.** The task carries the bare command;
 *    `promptSections/slashdo.js` resolves the roster from task metadata over
 *    Code Review Defaults at prompt build. Rendering `--review-with` at queue
 *    time would take slashdo's precedence-1 path, making task-level reviewer
 *    pins unreachable and freezing a roster that may sit queued. A per-run
 *    override is persisted as metadata (`reviewerConfig`) instead.
 *    **Self-review is the exception**: it is slashdo's own opt-out, so it rides
 *    the invocation (`--review-with none`, `REVIEW_AGENTS=[]`), and
 *    `resolveSlashdoReviewContract` recognizes it and prunes delegated reviewer
 *    loops so the pruning and the run agree.
 *  - **No contributor prose enters the prompt.** Only the PR number and URL;
 *    title, body and diff stay on the forge as untrusted data.
 */

import { UNTRUSTED_PULL_REQUEST_NOTICE } from '../lib/promptFencing.js';
import { getSlashdoWorkflow } from '../lib/slashdoCatalog.js';
import { emitLog } from './cos/cosEvents.js';
import { ServerError } from '../lib/errorHandler.js';
import { notificationAgentAccountBinding } from '../lib/githubNotificationTriage.js';

/** The bundled slashdo workflow this task runs. */
const DO_REVIEW_COMMAND = 'review';

/**
 * A `/do:review` task pinned to one request. `targetPullRequest` is the shared
 * "this task targets PR #N" key (`pr-reviewer` runs use it too); the two are told
 * apart by `slashdoCommand` here versus `analysisType` there.
 */
export const isDoReviewTask = (metadata) => metadata?.slashdoCommand === DO_REVIEW_COMMAND
  && metadata?.targetPullRequest != null;

/**
 * The task's agent-facing framing: which request, and that it is evidence rather
 * than instruction. Procedure lives in the inlined `/do:review` body.
 */
function renderContext({ number, url, repoLabel, selfReview }) {
  return [
    `Review pull request #${number} in ${repoLabel} (${url}) and publish the result as a review on that pull request.`,
    '',
    UNTRUSTED_PULL_REQUEST_NOTICE,
    '',
    'This run is review-only. The invocation carries `--no-apply`: publish findings as an inline review and do not commit, push, check the branch out, or merge. Landing the PR is a separate action the user triggers themselves.',
    ...(selfReview ? [
      '',
      'The invocation also carries `--review-with none`: YOU are the reviewer. Do not spawn, shell out to, or request any other review agent — your own pass is the whole review, so read the diff with the care you would otherwise delegate.',
    ] : []),
  ].join('\n');
}

/**
 * Queue and immediately start one `/do:review` run for an open pull request.
 *
 * Immediate dispatch because pressing the button IS the approval;
 * `suppressDequeue` keeps the autonomous dequeue from racing the force-spawn.
 * The result uses `spawnReviewLoopFollowUp`'s vocabulary (`duplicate` plus
 * `dispatch: { started, reason }`).
 *
 * `cos.js` is imported lazily to avoid its ~400-module closure in every test
 * that reaches this file (server/AGENTS.md, "Import scoping").
 *
 * `app` is null for a PR in a repo no app manages (PR mode reads through `gh`).
 * `reviewerConfig` is an already-sanitized override persisted for the prompt
 * layer; ignored under `selfReview`. `githubAccount` is the concrete viewer
 * selected (an implicit account may have a null login). `immediate: false`
 * leaves the task to the normal queue, for automation.
 * @returns {Promise<{task: Object|null, duplicate: boolean, dispatch: {started: boolean, reason: string|null}}>}
 */
export async function spawnPrDoReviewTask({
  app, pullRequest, repoFullName = '', provider, model, effort,
  selfReview = false, reviewerConfig = null, immediate = true,
  githubAccount = null, notificationAccount = null, notificationOrigin = 'user',
} = {}) {
  const { addTask } = await import('./cos/cosTaskStore.js');
  const { forceSpawnTask } = await import('./cos/cos.js');
  const { number, url } = pullRequest;
  const appLabel = app ? String(app.name || app.id).replace(/\s+/g, ' ').trim() : repoFullName;
  const repoLabel = repoFullName || appLabel;

  const created = await addTask({
    description: `Review PR #${number} for ${appLabel}`,
    ...(app ? { app: app.id } : {}),
    priority: 'HIGH',
    context: renderContext({ number, url, repoLabel, selfReview }),
    slashdoCommand: DO_REVIEW_COMMAND,
    // The URL puts slashdo into PR mode; see the module doc for why only
    // self-review rides the invocation.
    slashdoArgs: `${url} --no-apply${selfReview ? ' --review-with none' : ''}`,
    provider, model, effort,
    // Spread as top-level fields so `buildTaskMetadata` normalizes them like every
    // other dispatch surface; absent means the prompt layer uses Code Review Defaults.
    ...(selfReview ? {} : (reviewerConfig || {})),
    // The catalog's own posture for `review`, read so catalog changes reach here.
    ...getSlashdoWorkflow(DO_REVIEW_COMMAND).settings,
    // PR mode with `--no-apply` publishes a review, so commit/push/PR instructions are stripped.
    noCodeOutput: true,
    // Each `/do:*` body owns its own review sequence; a CoS loop on top would
    // review the review.
    reviewLoop: false,
    metadata: {
      targetPullRequest: number,
      ...(githubAccount ? { githubAccount } : {}),
      ...(notificationAccount ? { githubNotificationAccount: notificationAgentAccountBinding(notificationAccount, notificationOrigin) } : {}),
    },
  }, 'user', { suppressDequeue: immediate });

  if (!created) return { task: null, duplicate: false, dispatch: { started: false, reason: null } };
  if (created.duplicate) {
    const existingAccount = created.metadata?.githubAccount || created.metadata?.githubNotificationAccount;
    const expectedAccount = githubAccount || (notificationAccount && notificationAgentAccountBinding(notificationAccount, notificationOrigin));
    if (expectedAccount && (!existingAccount
      || (existingAccount.id || existingAccount.accountId) !== (expectedAccount.id || expectedAccount.accountId)
      || existingAccount.host?.toLowerCase() !== expectedAccount.host.toLowerCase()
      || (existingAccount.login || '').toLowerCase() !== (expectedAccount.login || '').toLowerCase())) {
      throw new ServerError('A review for this PR is already queued under a different GitHub account; finish it before requesting this account', {
        status: 409, code: 'GITHUB_REVIEW_ACCOUNT_CONFLICT',
      });
    }
    emitLog('info', `🔍 /do:review for ${repoLabel} #${number} is already queued as ${created.id}`, {
      taskId: created.id, appId: app?.id || null, prNumber: number,
    });
    return { task: created, duplicate: true, dispatch: { started: false, reason: null } };
  }
  if (!immediate) return { task: created, duplicate: false, dispatch: { started: false, reason: null } };

  const spawn = await forceSpawnTask(created.id).catch(err => ({ error: err.message }));
  if (spawn?.error) {
    // Persisted and queued; report why it has not started.
    emitLog('warn', `⏳ Queued /do:review task ${created.id} for ${repoLabel} #${number} — ${spawn.error}`, {
      taskId: created.id, appId: app?.id || null, prNumber: number,
    });
    return { task: created, duplicate: false, dispatch: { started: false, reason: spawn.error } };
  }
  emitLog('info', `🔍 Started /do:review agent for task ${created.id} (${repoLabel} request #${number})`, {
    taskId: created.id, appId: app?.id || null, prNumber: number,
  });
  return { task: created, duplicate: false, dispatch: { started: true, reason: null } };
}
