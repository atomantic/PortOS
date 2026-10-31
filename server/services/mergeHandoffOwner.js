/**
 * Who may hand a pending merge to PortOS (#12247): the registered running agent
 * that owns the branch, proven against its live task and checkout. Nothing here
 * is taken from the request, so an unverified, forked or detached owner is
 * refused. Also the repository identity key shared by the merge paths.
 */
import { resolveTaskTargetBranch, resolveTaskRemoteBranch } from '../lib/taskTargetBranch.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { isPlainObject } from '../lib/objects.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { PR_COMPLETIONS, agentPrHeldForOperator, prHeldForOperator } from '../lib/prDisposition.js';

export const repositoryKey = (origin) => origin?.host && origin?.fullName
  ? `${origin.host.replace(/^ssh\.github\.com$/i, 'github.com')}/${origin.fullName}`.toLowerCase()
  : null;
const ownerPath = (agent) => agent?.metadata?.sourceWorkspace || agent?.sourceWorkspace
  || agent?.metadata?.workspacePath || agent?.workspacePath;

const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

// The persisted task this live agent runs, or null once it is absent or final.
async function liveTask(agent) {
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(agent.taskId).catch(() => null);
  return task?.id === agent.taskId && !TERMINAL_TASK_STATUSES.includes(task.status) ? task : null;
}

// The registered checkout must still name this repository and have the
// assigned branch checked out; an unreadable checkout is not a match.
async function checkoutOnBranch(workspace, branch, repository) {
  if (repositoryKey(await getOriginInfo(workspace).catch(() => null)) !== repository) return false;
  const { execGit } = await import('../lib/execGit.js');
  const checkout = await execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspace).catch(() => null);
  return checkout?.stdout?.trim() === branch;
}

// Review-loop authority comes from the registered launch AND its live internal
// task. Never accept a repository/branch from a request or PR prose.
async function verifiedReviewCoordinator(agent, repository) {
  const target = agent.metadata?.reviewLoopMergeTarget;
  if (!isPlainObject(target) || typeof target.branch !== 'string' || !target.branch) return false;
  const task = await liveTask(agent);
  const meta = task?.metadata;
  if (!task || task.taskType !== 'internal'
    || !isTruthyMeta(meta?.reviewLoopFollowUp) || agentPrHeldForOperator(agent, task)
    || target.url !== meta?.reviewLoopPRUrl || target.branch !== meta?.reviewLoopPRBranch
    || resolveTaskRemoteBranch(meta) !== target.branch
    || agent.metadata?.worktreeBranch !== resolveTaskTargetBranch(meta) || !agent.metadata?.workspacePath) return false;
  const pr = parsePullRequestUrl(target.url);
  if (!pr || repositoryKey({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` }) !== repository
    || String(meta.reviewLoopPRNumber) !== String(pr.number)
    || meta.reviewLoopPRHost !== pr.host || meta.reviewLoopPROwner !== pr.owner || meta.reviewLoopPRRepo !== pr.repo) return false;
  if (target.detached) {
    if (meta.forkHead || meta.reviewLoopForkTarget || target.fork || agent.metadata.isWorktree !== true
      || repositoryKey(await getOriginInfo(agent.metadata.workspacePath).catch(() => null)) !== repository) return false;
    const { verifyDetachedReviewMergeTarget } = await import('./detachedReviewMergeTarget.js');
    const headSha = await verifyDetachedReviewMergeTarget({ target,
      workspacePath: agent.metadata.workspacePath, sourceWorkspace: agent.metadata.sourceWorkspace });
    return headSha ? { headSha } : false;
  }
  if (!await checkoutOnBranch(agent.metadata.workspacePath, resolveTaskTargetBranch(meta), repository)) return false;
  if (!meta.forkHead && !meta.reviewLoopForkTarget && !target.fork && !target.workspacePath) return true;
  if (target.workspacePath !== agent.metadata.workspacePath || !agent.metadata.sourceWorkspace
    || agent.metadata.sourceWorkspace === target.workspacePath || target.fork?.url !== target.url) return false;
  const { verifyForkReviewMergeTarget } = await import('./forkReviewMergeTarget.js');
  const headSha = await verifyForkReviewMergeTarget({ target: target.fork, taskTarget: meta.reviewLoopForkTarget,
    forkHead: meta.forkHead, sourceWorkspace: agent.metadata.sourceWorkspace,
    workspacePath: target.workspacePath, branch: target.branch, localBranch: agent.metadata.worktreeBranch });
  return headSha ? { headSha } : false;
}

// Generic PR delivery (#11435): an operator-configured task whose prompt told
// it to open AND merge its own PR from the worktree PortOS provisioned. The
// target is the spawn-time binding (that worktree and its head branch), never
// the request; the live task must still grant agent-owned delivery, and the
// checkout must still be that branch of this repository. A generic run cannot
// promote itself to claim authority: it admits only its own registered branch.
async function verifiedWorktreeDelivery(agent, repository) {
  const meta = agent.metadata;
  const target = meta?.prDeliveryTarget;
  if (!isPlainObject(target) || typeof target.branch !== 'string' || !target.branch
    || typeof target.workspacePath !== 'string' || !target.workspacePath) return false;
  const { PR_OPENED_BY } = await import('../lib/slashdoInvocation.js');
  if (meta.isWorktree !== true || meta.configOpenPR !== true || meta.configClaimFlow
    || ![PR_OPENED_BY.AGENT_SLASHDO, PR_OPENED_BY.AGENT_INLINE].includes(meta.prOpenedBy)
    || meta.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN
    || meta.worktreeBranch !== target.branch || meta.workspacePath !== target.workspacePath
    || !meta.sourceWorkspace || meta.sourceWorkspace === target.workspacePath) return false;
  const task = await liveTask(agent);
  const taskMeta = task?.metadata;
  if (!task || !isTruthyMeta(taskMeta?.openPR) || prHeldForOperator(task)
    || isTruthyMeta(taskMeta?.reviewLoopFollowUp) || taskMeta?.forkHead) return false;
  return checkoutOnBranch(target.workspacePath, target.branch, repository);
}

// A source-checkout coordinator owns only its scheduler-assigned targets. A
// successful ownership check selects one target, so an old reservation cannot
// outlive a policy or checkout change. No caller-supplied fields participate.
async function verifiedReconcileCoordinator(agent, repository, agents) {
  if (!agent.metadata?.reconcileMergeReservation) return false;
  const { reconcileMergeTarget } = await import('../lib/claimContinuation.js');
  const task = await liveTask(agent);
  const proof = reconcileMergeTarget(agent, task, agent.metadata.reconcileMergeReservation);
  if (!proof || repositoryKey(proof.assignment.origin) !== repository
    || !await checkoutOnBranch(proof.target.workspacePath, proof.target.branch, repository)) return false;
  const { checkReconcileOwnership } = await import('./cosClaimOwnership.js');
  const admission = await checkReconcileOwnership({ agentId: agent.id, appId: proof.assignment.appId,
    branch: proof.target.branch, worktreePath: proof.target.workspacePath }, {
    reserve: false, getAgents: async () => Object.values(agents),
    getAppById: async (appId) => {
      const { getAppById } = await import('./apps.js');
      const app = await getAppById(appId);
      return app?.repoPath === proof.assignment.repoPath ? app : null;
    },
  });
  return admission.admitted ? { reconcileTarget: proof.target } : false;
}

/**
 * The registered run a pending-merge handoff may bind (#12247): its live
 * participant proof, plus which branch that run owns and the registered
 * checkout holding it (null for a claim run, which cuts its own).
 * Fork review targets are refused —
 * the coordinator merges same-repository heads only.
 */
export async function resolveMergeHandoffOwner(agentId) {
  const { readMergeAdmissionStateForSafetyCheck } = await import('./cosState.js');
  const snapshot = await readMergeAdmissionStateForSafetyCheck().catch(() => null);
  if (!snapshot?.trusted || !isPlainObject(snapshot.agents)) return { refused: 'ownership-unreadable' };
  const agent = snapshot.agents[agentId];
  if (!agent || agent.id !== agentId || agent.status !== 'running' || !agent.startedAt || !agent.taskId) {
    return { refused: 'handoff-owner-unverified' };
  }
  const repository = ownerPath(agent) ? repositoryKey(await getOriginInfo(ownerPath(agent)).catch(() => null)) : null;
  if (!repository) return { refused: 'repository-unreadable' };
  const task = await liveTask(agent);
  if (!task) return { refused: 'handoff-owner-unverified' };
  const meta = agent.metadata || {};
  if (meta.reviewLoopMergeTarget?.fork || task.metadata?.forkHead) return { refused: 'fork-target-unsupported' };
  const owner = { agent, task, repository };
  if (isTruthyMeta(meta.claimPicksOwnBranch) || meta.claimBranch) {
    const { ownsClaimBranch } = await import('../lib/claimContinuation.js');
    return { ...owner, owns: (branch) => ownsClaimBranch(agent, branch), workspacePath: null };
  }
  if (await verifiedReviewCoordinator(agent, repository)) {
    return { ...owner, owns: (branch) => branch === meta.reviewLoopMergeTarget.branch, workspacePath: meta.workspacePath };
  }
  if (await verifiedWorktreeDelivery(agent, repository)) {
    return { ...owner, owns: (branch) => branch === meta.prDeliveryTarget.branch, workspacePath: meta.prDeliveryTarget.workspacePath };
  }
  const reconcile = await verifiedReconcileCoordinator(agent, repository, snapshot.agents);
  if (reconcile) return { ...owner, owns: branch => branch === reconcile.reconcileTarget.branch,
    workspacePath: reconcile.reconcileTarget.workspacePath };
  return { refused: 'handoff-owner-unverified' };
}
