import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PR_COMPLETIONS, leavesPrForHuman, resolvePrCompletion } from '../lib/prDisposition.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';

// Pinned checkout recovery for unbound pending merges. The pending-merge sweep
// stopped creating these targets when the merged-tree guard stopped gating
// merges (#14184); review follow-ups persisted with one still revalidate it
// here at dispatch and launch. Compatibility-only: the producer
// (`mergeGuardTarget` on spawnReviewLoopFollowUp) was removed after v2.107.0;
// retire this path once installs holding such queued tasks have upgraded.
export async function preparePendingMergeRecovery({ app, entry, headSha, launchTaskId = null }) {
  if (!/^[a-f0-9]{40}$/.test(headSha || '')) return { blocked: 'recovery-head-unreadable' };
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
  const agents = await readClaimOwnershipAgents();
  if (!agents || agents.some(agent => agent.taskId !== launchTaskId
    && (agent.id === entry.sourceAgentId || agent.taskId === entry.sourceTask?.id)
    && ['running', 'paused', 'orphaned', 'interrupted'].includes(agent.status))) return { deferred: true };
  const ignoreIds = agents.filter(agent => agent.taskId === launchTaskId).map(agent => agent.id);
  if (claimCheckoutOwnerReason({ branchName: entry.prBranch, sourceWorkspace: app.repoPath, agents, ignoreIds })) return { deferred: true };
  let task;
  const snapshot = !entry.sourceAgentId && entry.sourceTask?.id === `quality-snapshot-${app.id}`
    && entry.prBranch === 'portos/quality-snapshot';
  if (snapshot) {
    // The scheduled publisher has no agent task and deletes its temporary tree.
    // Its fixed producer policy is merge-on-green; never fabricate a task owner.
    task = entry.sourceTask;
  } else {
    const { getTaskById } = await import('./cosTaskStore.js');
    task = await getTaskById(entry.sourceTask?.id).catch(() => null);
    if (!task || task.metadata?.app !== app.id) return { blocked: 'recovery-owner-unreadable' };
    if (['pending', 'in_progress'].includes(task.status) && task.id !== launchTaskId) return { deferred: true };
    if (task.status !== 'completed' && !(task.id === launchTaskId && ['pending', 'in_progress'].includes(task.status))) return { blocked: 'recovery-owner-not-completed' };
    if (leavesPrForHuman(task) || isTruthyMeta(task.metadata?.readOnly) || isTruthyMeta(task.metadata?.reviewLoopLeaveOpen)
      || resolvePrCompletion(task.metadata) === PR_COMPLETIONS.LEAVE_OPEN) return { blocked: 'recovery-owner-policy-held' };
  }
  const policy = snapshot ? PR_COMPLETIONS.MERGE_ON_GREEN : resolvePrCompletion(task.metadata);
  const { followUpRoster } = await import('./mergeFollowUpPolicy.js');
  const roster = await followUpRoster(task, policy);
  const target = { version: 1, appId: app.id, repoPath: app.repoPath, prUrl: entry.prUrl,
    branch: entry.prBranch, headSha, sourceTaskId: task.id, sourceAgentId: entry.sourceAgentId || null,
    prCompletion: policy, roster };
  return { target, task, policy: { prCompletion: policy, ...roster } };
}

/** Rechecked before dispatch, before checkout, and before owner registration. */
export async function validatePendingMergeRecovery({ target, workspacePath, requireCheckout = false, launchTaskId = null }) {
  if (!target || target.version !== 1) return 'recovery-target-invalid';
  const { getAppById } = await import('./apps.js');
  const app = await getAppById(target.appId).catch(() => null);
  if (!app || app.repoPath !== target.repoPath) return 'recovery-app-changed';
  const entry = { prUrl: target.prUrl, prBranch: target.branch, sourceAgentId: target.sourceAgentId,
    sourceTask: { id: target.sourceTaskId, metadata: { app: app.id } } };
  const current = await preparePendingMergeRecovery({ app, entry, headSha: target.headSha, launchTaskId });
  if (current.blocked || current.deferred || !isDeepStrictEqual(current.target, target)) return current.blocked || 'recovery-owner-changed';
  const [{ getOriginInfo }, { parsePullRequestUrl }, { githubRepoSpec }, { resolveForgeExecOptions }, { execGh }, { repositoryKey }] = await Promise.all([
    import('../lib/gitRemote.js'), import('../lib/gitForge.js'), import('../lib/workTracker.js'),
    import('./forgeExecOptions.js'), import('./github.js'), import('./mergeHandoffOwner.js'),
  ]);
  const origin = await getOriginInfo(app.repoPath).catch(() => null);
  const pr = parsePullRequestUrl(target.prUrl);
  if (!origin || !pr || repositoryKey({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` }) !== repositoryKey(origin)) return 'recovery-repository-changed';
  const options = await resolveForgeExecOptions(app.repoPath, { forgeAccount: app.forgeAccount });
  const raw = await execGh(['pr', 'view', String(pr.number), '--repo', githubRepoSpec(origin),
    '--json', 'state,isDraft,isCrossRepository,headRefName,headRefOid'], undefined,
  { ...options, backoffKey: githubRepoSpec(origin) }).catch(() => null);
  let view;
  try { view = JSON.parse(raw); } catch { return 'recovery-pr-unreadable'; }
  if (view?.state !== 'OPEN' || view.isDraft !== false || view.isCrossRepository !== false
    || view.headRefName !== target.branch || view.headRefOid !== target.headSha) return 'recovery-head-moved';
  if (requireCheckout) {
    const { verifyPendingMergeCheckout } = await import('./pendingMergeCheckout.js');
    if (!await verifyPendingMergeCheckout(app.repoPath, workspacePath, target.branch, target.headSha)) return 'recovery-checkout-changed';
  } else if (resolve(workspacePath) !== resolve(app.repoPath)) return 'recovery-repository-changed';
  // A policy edit or an owner starting during the forge reads wins the race.
  const latest = await preparePendingMergeRecovery({ app, entry, headSha: target.headSha, launchTaskId });
  if (!isDeepStrictEqual(latest.target, target)) return latest.blocked || 'recovery-owner-changed';
  if (launchTaskId) {
    const { getTaskById } = await import('./cosTaskStore.js');
    const launch = await getTaskById(launchTaskId).catch(() => null);
    if (!launch || !['pending', 'in_progress'].includes(launch.status) || leavesPrForHuman(launch)
      || isTruthyMeta(launch.metadata?.readOnly) || isTruthyMeta(launch.metadata?.reviewLoopLeaveOpen)
      || resolvePrCompletion(launch.metadata) !== target.prCompletion
      || launch.metadata?.reviewLoopPRUrl !== target.prUrl || launch.metadata?.reviewLoopPRBranch !== target.branch
      || !isDeepStrictEqual(launch.metadata?.pendingMergeGuardTarget, target)) return 'recovery-launch-task-changed';
  }
  return null;
}
