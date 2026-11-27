/** Resume terminal checkout retirement on ownership, completion and delivery events. */

import { resolve } from 'path';
import { sameCheckoutPath } from '../../lib/pathContainment.js';
import { outsideGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { createSingleFlight } from '../../lib/singleFlight.js';
import { isHumanClaimWorktree, worktreeAgentId } from '../../lib/worktreeOwnership.js';
import { parsePullRequestUrl } from '../../lib/gitForge.js';
import { isTruthyMeta } from './agentState.js';
import { completedCheckoutReceiptValid } from '../completedCheckoutEvidence.js';
import { emitLog } from '../cos/cosEvents.js';
import { getTaskById } from '../cos/cosTaskStore.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';

export const CLAIM_OWNER_HOLDS = new Set(['claim-owner-active', 'claim-owner-ambiguous']);
export const agentIdOf = agent => agent.id || agent.agentId;

async function verifyReleasedSynchronization(agent) {
  if (agent?.status === 'completed' && (agent.metadata?.taskAnalysisType === 'release-sync'
    || (agent.metadata?.taskAnalysisType === 'do-release' && agent.metadata?.releasePublication?.synchronizationHandoffVersion === 2))) {
    const { verifyReleaseSynchronizationTask } = await import('../releaseSynchronization.js');
    await verifyReleaseSynchronizationTask(agent.taskId);
  }
}

function inheritedRetirementScope(agent) {
  const meta = agent.metadata;
  return agent.status === 'completed' && meta?.isWorktree === false && typeof meta.resumedFromAgentId === 'string'
    && meta.resumedFromAgentId !== agent.id && meta.checkoutCapture?.status === 'pending' && meta.checkoutCapture.unknown === true
    && Array.isArray(meta.checkoutCapture.targets) && meta.checkoutCapture.targets.length === 0
    && meta.completionCleanup?.status === 'pending' && !meta.completedCheckouts?.length
    && !meta.worktreeBranch && !meta.prDeliveryTarget && !meta.reviewLoopMergeTarget
    && meta.claimBranches?.length === 1;
}

export function createCompletionRetirement({
  verificationRuns, manualCleanupContext, verifyAgentRepoState,
  readAbsentTaskSnapshot, recordedCheckoutScope, pendingCheckoutScope, settleAbsentScope, skipped,
}) {
  async function settleAbsentCheckoutRetirement(agent) {
    let scope = pendingCheckoutScope(agent);
    let parent = null;
    if (!scope && inheritedRetirementScope(agent)) {
      const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
      parent = await getAgentRecord(agent.metadata.resumedFromAgentId).catch(() => null);
      scope = parent?.status === 'completed' && parent.taskId === agent.taskId ? recordedCheckoutScope(parent) : null;
      if (scope && (agent.metadata.claimBranches[0] !== scope.branch || agent.metadata.workspacePath !== scope.repoPath
        || scope.path === scope.repoPath)) scope = null;
    }
    if (!scope) return false;
    return settleAbsentScope(agent, { repoPath: scope.repoPath, branch: scope.branch, paths: [scope.path] },
      parent ? { inheritedFromAgentId: parent.id } : {});
  }

  /** Wake only this terminal job after its execution entry was released. The
   * periodic bounded sweep remains the durable fallback if the process exits. */
  const releasedCompletionRuns = createSingleFlight();
  function resumeAgentCompletionRetirement(agentId) {
    // The owner-release callback can inherit the finished spawn's closed Git
    // lifetime. Its fresh verification still uses the usual retirement gates.
    return releasedCompletionRuns.run(agentId, () => outsideGitMutationLifetime(() => resumeReleasedCompletion(agentId)));
  }

  async function resumeReleasedCompletion(agentId) {
    // A pre-release audit may still be settling an owner-active observation.
    // Wait for it, then start a fresh verification instead of joining its stale result.
    await verificationRuns.get(agentId)?.catch(() => {});
    const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
    const agent = await getAgentRecord(agentId);
    if (agent?.status !== 'completed') return;
    if (await settleAbsentCheckoutRetirement(agent)) return { verified: false, physicalRetirementVerified: true, skipReason: 'original-result-preserved' };
    const deliveryPending = agent.metadata?.repoStateVerification?.status === 'pending'
      && (agent.result?.cleanupPending === true || agent.result?.success === true);
    if (!deliveryPending && agent.metadata?.completionCleanup?.status !== 'pending') {
      await verifyReleasedSynchronization(agent);
      return;
    }
    const task = await getTaskById(agent.taskId);
    const { replayAgentCompletionCleanup } = await import('./agentCompletionCleanup.js');
    if (task) await replayAgentCompletionCleanup(agent);
    // Failed/no-change runs can still owe physical cleanup. The owner-release
    // event replays that obligation without changing their original verdict or
    // granting a new task/provider retry budget.
    if (!deliveryPending) {
      await verifyReleasedSynchronization(agent);
      return { verified: false, cleanupReplayed: Boolean(task), skipReason: 'original-result-preserved' };
    }
    const current = await getAgentRecord(agentId);
    const snapshot = !task && current.result?.success === true ? await readAbsentTaskSnapshot(current) : null;
    if (!task && current.result?.success === true && !snapshot) return skipped('cleanup-task-unavailable');
    const originalTask = task || snapshot || { id: agent.taskId };
    const result = await verifyAgentRepoState({ agentId, agentState: current, task: originalTask,
      ...(snapshot && { originTaskAbsent: true }),
      success: current.result?.success === true });
    const settled = await getAgentRecord(agentId);
    if (task) await replayAgentCompletionCleanup(settled);
    await verifyReleasedSynchronization(settled);
    return result;
  }

  /** A completed delivery follow-up settles its original job immediately. No
   * schedule, provider, retry reset or fabricated completion is involved. */
  const completedDeliveryParents = createSingleFlight();
  async function resumeCompletedDeliveryParent(task) {
    const m = task?.metadata;
    if (task?.status !== 'completed' || !isTruthyMeta(m?.reviewLoopFollowUp)
      || typeof m.sourceAgentId !== 'string' || !m.sourceAgentId || typeof m.sourceTaskId !== 'string') return;
    return completedDeliveryParents.run(JSON.stringify([m.sourceAgentId, m.sourceTaskId]), async () => {
      const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
      const [parent, instanceId] = await Promise.all([getAgentRecord(m.sourceAgentId), getInstanceId()]);
      if (parent?.taskId !== m.sourceTaskId || !instanceId || instanceId === UNKNOWN_INSTANCE_ID
        || parent.metadata?.instanceId !== instanceId) return;
      // A follow-up can merge after the original run exhausted pre-merge
      // contention rounds. Its already-completed cleanup ledger is not delivery
      // proof, nor a reason to ignore this event. Reuse the normal verifier with
      // the follow-up target; it independently checks the captured head, current
      // forge state, ownership and physical checkout before recording settlement.
      const result = parent.result;
      const recoveredDelivery = !!parsePullRequestUrl(m.reviewLoopPRUrl)
        && m.mergedReviewFollowUp?.status === 'verified'
        && m.mergedReviewFollowUp.prUrl === m.reviewLoopPRUrl
        && m.reviewLoopPRBranch === parent.metadata?.worktreeBranch
        && result?.deliveryRecoveryOwned === true && result.executionSuccess === true
        && result.validationPassed !== false && !result.executionInterruption
        && !parent.metadata?.executionInterruption
        && result.taskOutcome?.status === 'incomplete';
      if (!recoveredDelivery) return resumeAgentCompletionRetirement(m.sourceAgentId);
      await verificationRuns.get(m.sourceAgentId)?.catch(() => {});
      const original = await getTaskById(m.sourceTaskId);
      if (!original || original.status !== 'completed') return;
      const verified = await verifyAgentRepoState({ agentId: m.sourceAgentId, agentState: parent,
        task: { ...original, metadata: { ...original.metadata, reviewLoopPRUrl: m.reviewLoopPRUrl } },
        success: true, prProbeFallback: 'force-branch' });
      if (verified.verified) {
        const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
        await recordRepoStateVerification(m.sourceAgentId, { status: 'completed', deliveryVerified: true,
          checkedAt: new Date().toISOString(), sourceFollowUpTaskId: task.id });
      }
      return verified;
    });
  }

  // A possible claim owner may bind a different branch (or finish) just after a
  // completion pass records its hold. Retry only records that named that owner;
  // the ordinary ownership and retirement gates still make the final decision.
  const claimOwnershipWakes = new Map();
  function wakeClaimOwnershipHolds(ownerId, repository) {
    const existing = claimOwnershipWakes.get(ownerId);
    if (existing) { existing.dirty = true; return existing.promise; }
    const wake = { dirty: true };
    claimOwnershipWakes.set(ownerId, wake);
    wake.promise = (async () => {
      while (wake.dirty) {
        wake.dirty = false;
        const { readBranchCompletionPolicies } = await import('../branchCompletionPolicy.js');
        const agents = await readBranchCompletionPolicies({ repairIndex: false });
        const namesOwner = agent => Object.values(agent.metadata?.cleanupOutcomes || {}).some(row =>
          CLAIM_OWNER_HOLDS.has(row?.reason) && Array.isArray(row?.owners) && row.owners.includes(ownerId));
        const sameRepo = agent => {
          const path = agent.metadata?.sourceWorkspace || agent.metadata?.workspacePath;
          if (typeof repository !== 'string' || !repository || typeof path !== 'string' || !path) return true;
          const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
          return normalize(repository) === normalize(path);
        };
        const candidates = agents.filter(agent => agent.status === 'completed' && agent.metadata?.repoStateVerification?.status === 'pending'
          && (namesOwner(agent) || (sameRepo(agent) && verificationRuns.has(agentIdOf(agent)))));
        const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
        for (const agent of candidates) {
          const id = agentIdOf(agent);
          // A pass may have read the old owner before this event and not yet
          // persisted its hold. Wait only for that candidate, then reread it.
          await verificationRuns.get(id)?.catch(() => {});
          const current = await getAgentRecord(id);
          if (current?.metadata?.repoStateVerification?.status === 'pending' && namesOwner(current)) await resumeAgentCompletionRetirement(id);
        }
      }
    })().finally(() => claimOwnershipWakes.delete(ownerId));
    return wake.promise;
  }

  /** Bind the deterministic receipt handoff, including duplicate completion replay. */
  function bindCompletionRetirementEvents(events) {
    const onChange = data => {
      if (data?.suppressCompletionWake || manualCleanupContext.getStore()
        || data?.task?.status !== 'completed' || !data.task.metadata?.reviewLoopFollowUp) return;
      return resumeCompletedDeliveryParent(data.task)
        .catch(error => emitLog('warn', `Parent completion deferred after delivery follow-up: ${error.message}`, { taskId: data.task.id }));
    };
    const onRetirement = async receipt => {
      if (manualCleanupContext.getStore()) return;
      if (!receipt?.appId || !receipt.path || !receipt.branch) return;
      const [{ getAppById }, { readBranchCompletionPolicies }] = await Promise.all([
        import('../apps.js'), import('../branchCompletionPolicy.js'),
      ]);
      const [app, agents] = await Promise.all([getAppById(receipt.appId), readBranchCompletionPolicies({ repairIndex: false })]);
      if (!app?.repoPath) return;
      const matches = agents.filter(agent => agent.status === 'completed'
        && agent.metadata?.repoStateVerification?.status === 'pending'
        && agent.metadata.completedCheckouts?.some(row => completedCheckoutReceiptValid(agent, row)
          && sameCheckoutPath(row.repoPath, app.repoPath) && sameCheckoutPath(row.path, receipt.path) && row.branch === receipt.branch));
      const pending = agents.filter(agent => agent.status === 'completed' && agent.metadata?.checkoutCapture?.status === 'pending'
        && sameCheckoutPath(agent.metadata.sourceWorkspace, app.repoPath) && agent.metadata.worktreeBranch === receipt.branch
        && sameCheckoutPath(agent.metadata.workspacePath, receipt.path));
      for (const agent of new Set([...matches, ...pending])) await resumeAgentCompletionRetirement(agentIdOf(agent));
    };
    const onReceipt = receipt => onRetirement(receipt)
      .catch(error => emitLog('warn', `Completion deferred after retirement receipt: ${error.message}`, { appId: receipt?.appId }));
    const onCapture = data => {
      if (manualCleanupContext.getStore() || typeof data?.agentId !== 'string' || !data.agentId) return;
      return resumeAgentCompletionRetirement(data.agentId)
        .catch(error => emitLog('warn', `Completion deferred after checkout capture: ${error.message}`, { agentId: data.agentId }));
    };
    const onClaimOwnership = data => {
      if (manualCleanupContext.getStore()) return;
      const ownerId = data?.agentId || data?.id;
      if (typeof ownerId !== 'string' || !ownerId) return;
      const repository = data?.repository || data?.sourceWorkspace || data?.metadata?.sourceWorkspace || data?.workspacePath || data?.metadata?.workspacePath;
      return wakeClaimOwnershipHolds(ownerId, repository)
        .catch(error => emitLog('warn', `Completion deferred after claim ownership changed: ${error.message}`, { agentId: ownerId }));
    };
    const onClaimOwnerCompleted = agent => {
      const meta = agent?.metadata;
      const checkoutPath = agent?.workspacePath || meta?.workspacePath;
      const claimCheckout = meta?.isWorktree && ((typeof checkoutPath === 'string' && isHumanClaimWorktree(worktreeAgentId(checkoutPath)))
        || (typeof meta.worktreeBranch === 'string' && /^(claim|next)\//.test(meta.worktreeBranch)));
      if (!claimCheckout && !agent?.claimBranch && !meta?.claimBranch && !agent?.claimPicksOwnBranch && !meta?.claimPicksOwnBranch
        && !agent?.claimSelectionPending && !meta?.claimSelectionPending && !agent?.claimBranches?.length && !meta?.claimBranches?.length
        && !meta?.reconcileReservations?.length && !meta?.releaseCandidate) return;
      return onClaimOwnership(agent);
    };
    events.on('tasks:changed', onChange);
    events.on('checkout:retired', onReceipt);
    events.on('agent:checkout-captured', onCapture);
    events.on('claim:ownership-changed', onClaimOwnership);
    events.on('agent:completed', onClaimOwnerCompleted);
    return () => {
      events.off('tasks:changed', onChange);
      events.off('checkout:retired', onReceipt);
      events.off('agent:checkout-captured', onCapture);
      events.off('claim:ownership-changed', onClaimOwnership);
      events.off('agent:completed', onClaimOwnerCompleted);
    };
  }

  return { settleAbsentCheckoutRetirement, resumeAgentCompletionRetirement, resumeCompletedDeliveryParent, bindCompletionRetirementEvents };
}
