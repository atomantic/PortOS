/**
 * Agent Repo-State Sweep, Prelude, and Event-Wake Orchestration
 *
 * Extracted sibling of `agentRepoStateVerification.js` owning periodic sweeps,
 * startup/release deferred-verification wakes, legacy-repair preludes, and
 * event-bus retirement listeners. Receives single-run verification primitives
 * via `createRepoStateSweep` to keep the module graph acyclic while preserving
 * `agentRepoStateVerification.js`'s public export surface and `vi.mock` targets.
 */
import { resolve } from 'path';
import { sameCheckoutPath } from '../../lib/pathContainment.js';
import { outsideGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { createSingleFlight } from '../../lib/singleFlight.js';
import { isHumanClaimWorktree, worktreeAgentId } from '../../lib/worktreeOwnership.js';
import { parsePullRequestUrl } from '../../lib/gitForge.js';
import { claimCheckoutOwner } from '../../lib/claimContinuation.js';
import { COMPLETION_RECOVERY_BATCH_SIZE } from './agentDeliveryActivity.js';
import { isTruthyMeta } from './agentState.js';
import { completedCheckoutReceiptValid, shortBranch } from '../completedCheckoutEvidence.js';
import { readLocalBranchPresence } from '../repoCleanupObservation.js';
import { emitLog } from '../cos/cosEvents.js';
import { getTaskById } from '../cos/cosTaskStore.js';
import { listWorktrees } from '../worktreeManager.js';
import { readAllTasksFlat } from '../investigationTaskProducer.js';
import { readClaimOwnershipAgents } from '../cos/cosClaimOwnership.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';

const CLAIM_OWNER_HOLDS = new Set(['claim-owner-active', 'claim-owner-ambiguous']);
const agentIdOf = agent => agent.id || agent.agentId;

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

const awaitsSwarmContinuation = row => row.status === 'completed' && row.result?.success === true
  && row.metadata?.swarmCleanupDelivery?.version === 1
  && !row.metadata.swarmCleanupDelivery.continuationIssued;

const ownsUnverifiedDeliveryRecovery = agent => agent.status === 'completed'
  && agent.result?.deliveryRecoveryOwned === true && agent.result.executionSuccess === true
  && agent.metadata?.repoStateVerification?.deliveryVerified !== true;

const lastCompletionAuditAttempt = agent => [agent.metadata.repoStateVerification?.checkedAt, agent.metadata.completionCleanup?.updatedAt,
  agent.metadata.completionCleanup?.lastAttemptAt].filter(value => typeof value === 'string').sort().at(-1) || '';

const awaitsCompletionAudit = agent => agent.status === 'completed' && (agent.metadata?.repoStateVerification?.status === 'pending'
  || agent.metadata?.completionCleanup?.status === 'pending');

const heldByClaimOwner = agent => agent.metadata.repoStateVerification?.status === 'pending'
  && Array.isArray(agent.metadata.repoStateVerification.reasons)
  && agent.metadata.repoStateVerification.reasons.some(reason => CLAIM_OWNER_HOLDS.has(reason));

// A claim-owner hold may skip its backoff when the caller asks to recheck holds.
const completionAuditDue = (agent, recheckClaimHolds) => !agent.metadata.completionCleanup?.retryAt
  || Date.parse(agent.metadata.completionCleanup.retryAt) <= Date.now()
  || (recheckClaimHolds && heldByClaimOwner(agent));

function selectPendingCompletionAudits(agents, { onlyAgentIds, recheckClaimHolds }) {
  return agents.filter(awaitsCompletionAudit)
    .filter(agent => completionAuditDue(agent, recheckClaimHolds))
    .filter(agent => !onlyAgentIds || onlyAgentIds.has(agentIdOf(agent)))
    .sort((a, b) => lastCompletionAuditAttempt(a).localeCompare(lastCompletionAuditAttempt(b)));
}

// Back off exponentially from one minute to 30 minutes, then double the wait for
// each further day of failed attempts, up to one day. Some audits can never settle
// (their task was deleted), and each attempt costs git and forge reads; retirement,
// ownership and follow-up events still wake a record whatever its backoff.
const REPLAY_ATTEMPTS_PER_DAY = 48;
const MAX_REPLAY_DELAY_MS = 24 * 60 * 60_000;
function completionReplayDelayMs(attempt) {
  const base = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempt - 1, 5));
  return Math.min(MAX_REPLAY_DELAY_MS, base * 2 ** Math.min(Math.floor((attempt - 1) / REPLAY_ATTEMPTS_PER_DAY), 6));
}

async function recordCompletionReplayAttempt(original) {
  const { recordCompletionCleanup } = await import('../cos/cosAgentLifecycle.js');
  const attempt = (original.metadata.completionCleanup?.replayAttempts || 0) + 1;
  await recordCompletionCleanup(agentIdOf(original), original.startedAt, { lastAttemptAt: new Date().toISOString(),
    replayAttempts: attempt, retryAt: new Date(Date.now() + completionReplayDelayMs(attempt)).toISOString() });
}

// Older receipts already proved delivery and cleanup, but left the deferred
// domain verdict pending. Replay the existing writer, without another probe,
// task, completion event or provider budget expenditure.
async function replayDeferredDeliverySettlements(agents) {
  const { recordRepoStateVerification, isSettleableCompletionReceipt } = await import('../cos/cosAgentLifecycle.js');
  const { agentRunDeliveryNeedsReconciliation } = await import('./agentRunTracking.js');
  const candidates = agents.filter(row => {
    const result = row.result?.deferredDeliveryOutcome ? { ...row.result, cleanupPending: true,
      taskOutcome: row.result.deferredDeliveryOutcome } : row.result;
    return row.status === 'completed' && isSettleableCompletionReceipt({ ...row, result }, row.metadata || {});
  }).sort((a, b) => Number(a.result?.success === true) - Number(b.result?.success === true)
    || (b.completedAt || '').localeCompare(a.completedAt || ''));
  let replayed = 0;
  for (const agent of candidates) {
    if (replayed >= COMPLETION_RECOVERY_BATCH_SIZE) break;
    if (agent.result?.success === true && !await agentRunDeliveryNeedsReconciliation(agent)) continue;
    replayed++;
    await recordRepoStateVerification(agentIdOf(agent), agent.metadata.repoStateVerification).catch(error => {
      emitLog('warn', `Deferred delivery settlement retained: ${error.code || 'receipt-unavailable'}`);
    });
  }
}

// Mark any durable request whose agent was recorded before a crash. Its fence
// remains until admission settles, and then either side can remove it.
async function acknowledgeIssuedSwarmRefills(agents) {
  const issuedAgents = new Set(agents.filter(row => row.metadata?.swarmCleanupDelivery?.continuationIssued === true)
    .map(agentIdOf));
  if (!issuedAgents.size) return;
  const { loadSchedule } = await import('../taskScheduleStore.js');
  const schedule = await loadSchedule().catch(() => null);
  const fences = schedule?.swarmCleanupRefillPending || {};
  const staleFences = Object.keys(fences).filter(id => {
    const handoff = schedule.onDemandHandoffs?.[fences[id].id];
    return issuedAgents.has(id) && (!fences[id].sourceMarked || (handoff && handoff.status !== 'preparing'));
  }).slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
  if (!staleFences.length) return;
  const { acknowledgeSwarmCleanupRefill } = await import('../taskSchedule.js');
  for (const id of staleFences) await acknowledgeSwarmCleanupRefill(id).catch(error => {
    emitLog('warn', `Swarm refill receipt cleanup deferred: ${error.message}`, { agentId: id });
  });
}

export function createRepoStateSweep({
  verificationRuns,
  manualCleanupContext,
  verifyAgentRepoState,
  notifyDeliveredSwarmCleanup,
  readAbsentTaskSnapshot,
  recordedCheckoutScope,
  pendingCheckoutScope,
  settleAbsentScope,
  settleReleasedSelectionHistory,
  skipped,
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

  let completionSweep = null;
  let completionWake = null;
  const runCompletionPass = run => {
    if (completionSweep) return completionSweep;
    completionSweep = Promise.resolve().then(run).finally(() => { completionSweep = null; });
    return completionSweep;
  };

  /** Resume interrupted completion from existing agent archives, bounded per pass. */
  function sweepRepoStateVerifications() {
    return runCompletionPass(() => resumeCompletionAudits());
  }

  /** An actual startup/release wake drains its initial eligible snapshot once,
   * yielding between existing bounded batches. Failed records retain backoff and
   * cannot cycle through this wake again, even when a slow batch outlasts retryAt.
   */
  function resumeDeferredRepoStateVerifications(blocked) {
    if (typeof blocked !== 'function') return Promise.reject(new Error('completion-recovery-gate-required'));
    if (completionWake) return completionWake;
    completionWake = (async () => {
      while (completionSweep) await completionSweep;
      return runCompletionPass(async () => {
        let remaining;
        let checked = 0;
        let pendingAtStart = 0;
        while (true) {
          const reason = await blocked();
          if (reason) return { checked, pendingAtStart, skipReason: reason };
          const result = await resumeCompletionAudits({ onlyAgentIds: remaining, skipPrelude: remaining !== undefined, recheckClaimHolds: true, legacyRepairs: true });
          if (!remaining) {
            pendingAtStart = result.pendingAtStart;
            remaining = new Set(result.pendingAgentIds);
          }
          for (const id of result.attemptedAgentIds) remaining.delete(id);
          checked += result.checked;
          if (!remaining.size || result.checked === 0) return { checked, pendingAtStart };
          await new Promise(nextTick => setImmediate(nextTick));
        }
      });
    })().finally(() => { completionWake = null; });
    return completionWake;
  }

  async function reconcileReleasedSelectionHistory(agents) {
    for (const agent of agents) {
      const meta = agent.metadata || {};
      if (agent.status !== 'completed' || meta.repoStateVerification?.status !== 'completed') continue;
      const branches = Object.values(meta.cleanupOutcomes || {}).filter(row => row.status === 'verified'
        && row.reason === 'released-selection-no-local-artifacts' && meta.claimReleasedBranches?.includes(row.branch)
        && !meta.claimBranches?.includes(row.branch)
        && Object.values(meta.cleanupOutcomes || {}).some(held => held.branch === row.branch && held.status !== 'verified'))
        .map(row => row.branch);
      if (!branches.length) continue;
      const sourceWorkspace = meta.sourceWorkspace || meta.workspacePath;
      if (typeof sourceWorkspace !== 'string') continue;
      const trees = await listWorktrees(sourceWorkspace).catch(() => null);
      const owners = await readClaimOwnershipAgents().catch(() => null);
      if (!trees || !owners) continue;
      for (const branch of new Set(branches)) {
        if (claimCheckoutOwner({ branchName: branch, sourceWorkspace, agents: owners, ignoreIds: [agentIdOf(agent)] })
          || trees.some(tree => shortBranch(tree.branch) === branch)
          || await readLocalBranchPresence(sourceWorkspace, branch).catch(() => null) !== false) continue;
        await settleReleasedSelectionHistory(agentIdOf(agent), meta, branch, trees)
          .catch(error => emitLog('warn', `Released-selection ledger repair deferred for ${agentIdOf(agent)}: ${error.message}`));
      }
    }
  }

  // Rotate pending registered checkout scopes with the existing attempt timestamp.
  async function replayPendingCheckoutRetirements(agents) {
    const due = agents.filter(pendingCheckoutScope)
      .sort((a, b) => (a.metadata.completionCleanup.lastAttemptAt || '').localeCompare(b.metadata.completionCleanup.lastAttemptAt || ''))
      .slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const agent of due) {
      const settled = await settleAbsentCheckoutRetirement(agent).catch(error => {
        emitLog('warn', `Checkout retirement settlement deferred for ${agent.id}: ${error.message}`);
        return false;
      });
      if (settled) continue;
      const { recordCompletionCleanup } = await import('../cos/cosAgentLifecycle.js');
      await recordCompletionCleanup(agent.id, agent.startedAt, { lastAttemptAt: new Date().toISOString() }).catch(error => {
        emitLog('warn', `Checkout retirement attempt retained: ${error.message}`);
      });
    }
  }

  // A crash can occur after retirement settled the task but before the verified
  // drain's refill was queued. Its exact source receipt survives in the agent
  // archive, so replay that continuation without rerunning work.
  async function replaySwarmCleanupContinuations(agents) {
    const replays = agents.filter(awaitsSwarmContinuation)
      .sort((a, b) => (a.metadata.swarmCleanupDelivery.lastAttemptAt || '')
        .localeCompare(b.metadata.swarmCleanupDelivery.lastAttemptAt || ''))
      .slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const agent of replays) {
      const agentId = agentIdOf(agent);
      const { recordSwarmCleanupContinuationAttempt } = await import('../cos/cosAgentLifecycle.js');
      await recordSwarmCleanupContinuationAttempt(agentId).catch(error => {
        emitLog('warn', `Swarm continuation attempt could not be recorded: ${error.message}`, { agentId });
      });
      await notifyDeliveredSwarmCleanup(agentId).catch(error => {
        emitLog('warn', `Swarm continuation replay deferred: ${error.message}`, { agentId });
      });
    }
  }

  // Replay completed handoffs after restart as well as at their event. Only
  // terminal parents with unfinished delivery qualify; ordinary completed history
  // never incurs a forge probe. Existing batch bounds still apply.
  async function resumeVerifiedFollowUpParents(agents) {
    const parents = new Set(agents.filter(ownsUnverifiedDeliveryRecovery).map(agentIdOf));
    if (!parents.size) return;
    const followUps = (await readAllTasksFlat()).filter(task => task.status === 'completed'
      && task.metadata?.mergedReviewFollowUp?.status === 'verified'
      && parents.has(task.metadata.sourceAgentId)).slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const task of followUps) await resumeCompletedDeliveryParent(task);
  }

  // legacyRepairs: repairs for records written by older versions. Upgraded
  // installs need them once per start, so only the startup/resume wake runs them.
  async function runCompletionAuditPrelude(agents, { legacyRepairs }) {
    const { recoverReleaseSynchronizationHandoffs } = await import('../releaseSynchronization.js');
    await recoverReleaseSynchronizationHandoffs(agents).catch(error => {
      emitLog('warn', `Release synchronization handoffs retained: ${error.code || 'outbox-unavailable'}`);
    });
    if (legacyRepairs) await reconcileReleasedSelectionHistory(agents);
    await replayPendingCheckoutRetirements(agents);
    if (legacyRepairs) await replayDeferredDeliverySettlements(agents);
    await replaySwarmCleanupContinuations(agents);
    await acknowledgeIssuedSwarmRefills(agents);
    await resumeVerifiedFollowUpParents(agents);
    const { reconcileCleanupThreads } = await import('../brainTaskThreads.js');
    await reconcileCleanupThreads({ dryRun: false }).catch(error => emitLog('warn', `Cleanup thread reconciliation deferred: ${error.message}`));
    if (!legacyRepairs) return;
    const { recoverLegacyDeliveryBlocks } = await import('../deliveryRecovery.js');
    await recoverLegacyDeliveryBlocks(agents);
  }

  // Definite absence may use the existing immutable-snapshot receipt proof. An
  // unreadable task is not absent, and neither case replays external stages.
  async function settleTasklessCompletionAudit(agent, { readable }) {
    const resumed = readable && (agent.result?.cleanupPending === true || agent.result?.success === true)
      ? await resumeAgentCompletionRetirement(agentIdOf(agent)).catch(() => null) : null;
    if (resumed?.verified) return;
    const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
    await recordRepoStateVerification(agentIdOf(agent), { status: 'pending',
      checkedAt: new Date().toISOString(), reasons: [resumed?.skipReason || 'task-unavailable'] });
  }

  async function verifyAndReplayCompletion(agent, task) {
    const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
    const { replayAgentCompletionCleanup } = await import('./agentCompletionCleanup.js');
    const deferCleanup = error => emitLog('warn', `Completion cleanup deferred for ${agent.id}: ${error.message}`, { agentId: agent.id });
    await replayAgentCompletionCleanup(agent).catch(deferCleanup);
    const refreshed = await getAgentRecord(agentIdOf(agent)).catch(() => null) || agent;
    await verifyAgentRepoState({ agentId: agentIdOf(refreshed), agentState: refreshed, task,
      success: refreshed.result?.success === true, prProbeFallback: 'sweep-review-target' })
      .catch(error => emitLog('warn', `Completion recovery deferred for ${refreshed.id}: ${error.message}`, { agentId: refreshed.id }));
    const updated = await getAgentRecord(agentIdOf(refreshed)).catch(() => null);
    if (updated) await replayAgentCompletionCleanup(updated)
      .catch(error => emitLog('warn', `Completion cleanup deferred for ${refreshed.id}: ${error.message}`, { agentId: refreshed.id }));
  }

  // Returns false only when the record turned out to be already settled, so the
  // caller's `checked` count excludes it.
  async function resumePendingCompletionAudit(original, loadTaskById) {
    const { getAgentRecord, recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
    let agent = await getAgentRecord(agentIdOf(original)).catch(() => null) || original;
    if (agent.metadata.completionCleanup?.status === 'completed' && agent.metadata.checkoutCapture?.status === 'retired'
      && agent.metadata.repoStateVerification?.physicalRetirementVerified === true) {
      await recordRepoStateVerification(agentIdOf(agent), agent.metadata.repoStateVerification);
      agent = await getAgentRecord(agentIdOf(agent)).catch(() => null) || agent;
    }
    if (agent.metadata.completionCleanup?.status === 'completed' && agent.metadata.repoStateVerification?.status === 'completed') return false;
    if (!pendingCheckoutScope(agent) && await settleAbsentCheckoutRetirement(agent)) return true;
    await recordCompletionReplayAttempt(original);
    agent = await getAgentRecord(agentIdOf(original)).catch(() => null) || original;
    const lookup = await loadTaskById(agent.taskId).then(task => ({ task, readable: true }), () => ({ task: null, readable: false }));
    const { task } = lookup;
    if (!task) await settleTasklessCompletionAudit(agent, lookup);
    else await verifyAndReplayCompletion(agent, task);
    return true;
  }

  async function resumeCompletionAudits({ onlyAgentIds, skipPrelude = false, recheckClaimHolds = false, legacyRepairs = false } = {}) {
    const { readBranchCompletionPolicies } = await import('../branchCompletionPolicy.js');
    const agents = await readBranchCompletionPolicies({ repairIndex: false });
    if (!skipPrelude) await runCompletionAuditPrelude(agents, { legacyRepairs });
    const pending = selectPendingCompletionAudits(agents, { onlyAgentIds, recheckClaimHolds });
    let checked = 0;
    const selected = pending.slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const original of selected) {
      if (await resumePendingCompletionAudit(original, getTaskById)) checked++;
    }
    return { checked, pendingAtStart: pending.length, pendingAgentIds: pending.map(agentIdOf),
      attemptedAgentIds: selected.map(agentIdOf) };
  }

  return {
    resumeAgentCompletionRetirement,
    bindCompletionRetirementEvents,
    sweepRepoStateVerifications,
    resumeDeferredRepoStateVerifications,
  };
}
