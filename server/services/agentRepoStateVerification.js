import { recoverCompletionTaskHandoff } from './agentCompletionTaskHandoff.js';
import { MANAGED_WORKTREE_CLEANUP_CONTRACT } from '../lib/mergeGateContract.js';
import { processAuditFingerprint } from '../lib/persistentMindProcessAudit.js';
import { completionSentinelPresent } from './agentCompletionSentinel.js';
import { hasClaimCheckoutBindings } from './completedCheckoutEvidence.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { sameRetirementObservation } from '../lib/reconcileRetirementEvidence.js';
/**
 * Agent Repo-State Verification
 *
 * The programmatic audit that runs after `cleanupAgentWorktree` and asks the
 * question cleanup cannot: is the repository actually in the state this task
 * asked for?
 *
 * Cleanup reports only what it TRIED and failed to do. The case this exists for
 * is an agent that opens its own PR (`metadata.prOpenedBy` naming the agent),
 * merges it itself, and exits before deleting the branch — or exits with the PR
 * still open.
 * Cleanup may stand down for those runs, leaving the branch and checkout for
 * another completion owner.
 *
 * It probes and classifies via `lib/repoStateExpectations.js`, tries the shared
 * deterministic cleanup gates, and files one recovery task when needed. A held
 * merged checkout requires persisted inventory and a fresh review preview;
 * the recovery agent cannot substitute shell deletion for a retirement receipt.
 *
 * Detection is what this adds over `branchReconcile.js`: that reconciler is an
 * opt-in scheduled task on a recheck cadence, and it parks on no-progress. This
 * is immediate, per-agent, and attributed to the run that caused it.
 *
 * Gated per managed app by `verifyRepoStateOnCompletion` (default ON).
 *
 * Concurrency: other agents legitimately hold their own worktrees and branches at
 * the same time. Every probe is scoped to ONE branch — the one this agent owned —
 * so a live sibling agent is structurally invisible to it.
 */

import { readLocalBranchPresence, readCheckoutPathPresence, inspectOpenDeliveryRepair } from './repoCleanupObservation.js';
import { join, resolve } from 'path';
import { emitLog } from './cosEvents.js';
import { addTask, updateTask } from './cosTaskStore.js';
import * as git from './git.js';
import { listWorktrees } from './worktreeManager.js';
import { listRemoteHeads, driveToMerge } from './branchReconcile.js';
import { readAllTasksFlat } from './investigationTaskProducer.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/fileUtils.js';
import { isTruthyMeta } from './agentState.js';
import { RECOVERY_TASK_PREFIX } from './recoveryTasks.js';
import { resolveTaskTargetBranch } from '../lib/taskTargetBranch.js';
import { leavesPrForHuman, prStaysOpen, resolvePrCompletion, PR_COMPLETIONS } from '../lib/prDisposition.js';
import { probePrForBranch, probeChangeRequestState } from './prProbe.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { ensureTaskThread } from './brainTaskThreads.js';
import {
  REPO_STATE_ISSUES,
  REPO_STATE_SKIPS,
  classifyRepoStateIssues,
  repoStateVerificationEnabled,
  resolveRepoStateExpectation,
} from '../lib/repoStateExpectations.js';

// A task in any of these still HOLDS its branch and will resume on it, so a
// branch one of them targets is owned, not leaked. `challenged` is the easy one
// to miss: it is a parked-for-dispute status, not a terminal one, and its task
// keeps its resume pointer (`cosTaskStore.js` `challengeTask`).
const PENDING_OWNER_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'challenged']);

/**
 * Is something ALREADY queued to land this branch?
 *
 * Two owners can hold a branch after cleanup returns, and neither is a leak:
 *
 *   1. a review-loop / merge follow-up TASK, which checks the branch out, drives
 *      the reviewers, and merges; and
 *   2. a pr-watcher PENDING MERGE (`pendingMergePrs` on the app record) — the
 *      model-free path a merge-on-green GitHub PR takes, merged by the next
 *      watcher tick once CI is green.
 *
 * In both cases the branch is *supposed* to still exist right now, so auditing it
 * would report the thing about to land it as debris. The follow-up is itself a
 * worktree agent, so its own completion gets audited; a pr-watcher merge is
 * audited by nothing here, deliberately — pr-watcher owns that PR end to end.
 *
 * @param {string} branchName
 * @param {object|null} app - the managed app record (carries `pendingMergePrs`)
 * @returns {Promise<boolean>}
 */
async function branchHasPendingOwner(branchName, app, cleanupOwner = null) {
  // `resolveTaskTargetBranch` is the canonical "which branch does this task own"
  // reader — matching `reviewLoopPRBranch` by hand here would miss a retry holding
  // the same branch through `existingBranch`.
  //
  // `null` on an unreadable queue, never `false`: the caller fails closed on it.
  // Collapsing "we could not read the task file" into "nobody owns this branch" is
  // how a transient read failure files recovery work against a branch a follow-up
  // is queued to land.
  const tasks = await readAllTasksFlat().catch(() => null);
  if (!tasks) return null;
  const claimedByTask = tasks.some(t =>
    !(cleanupOwner && t.id === cleanupOwner.taskId && t.metadata?.deliveryRecovery === 'cleanup'
      && t.metadata.deliveryRecoveryAgentId === cleanupOwner.agentId)
    && PENDING_OWNER_STATUSES.has(t.status) && resolveTaskTargetBranch(t.metadata) === branchName
  );
  if (claimedByTask) return true;

  if (!app) return false;
  const { readPendingMergePrs } = await import('./prWatcher.js');
  const pending = readPendingMergePrs(app);
  if (!Array.isArray(pending)) return null;
  return pending.some(entry => entry?.prBranch === branchName);
}

/**
 * Probe merge evidence, returning null when the preliminary ref checks fail.
 *
 * @returns {Promise<boolean|null>} null when either ref could not be resolved
 */
async function probeBranchMerged(repoPath, branch, target) {
  const resolvable = async (ref) => execGit(['rev-parse', '--verify', `${ref}^{commit}`], repoPath, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  const [hasBranch, hasTarget] = await Promise.all([resolvable(branch), resolvable(target)]);
  if (!hasBranch || !hasTarget) return null;
  return git.hasBranchMergeEvidence(repoPath, branch, target).catch(() => null);
}

/**
 * Probe the repository for the facts the expectation is judged against.
 *
 * Every field is tri-state: `true` / `false` / `null` for "could not determine".
 * A probe that throws yields `null`, never `false` — see `classifyRepoStateIssues`
 * for why collapsing the two would file a recovery task on every network hiccup.
 *
 * The four probe groups are independent and run concurrently, so latency is the
 * slowest one rather than their sum; only `branchMerged` (needs the local branch
 * and the default branch) is sequenced after its inputs.
 *
 * @param {object} params
 * @param {string} params.sourceWorkspace - the parent repository
 * @param {string} params.branchName
 * @param {string} params.worktreePath
 * @param {boolean} params.branchShouldBeGone - gates the remote + merged probes
 * @param {boolean} params.prExpected - gates the forge lookup
 * @returns {Promise<{worktreePresent: boolean|null, localBranchPresent: boolean|null, remoteBranchPresent: boolean|null, branchMerged: boolean|null, prState: string|null, prUrl: string|null, defaultBranch: string|null}>}
 */
async function probeRepoState({ sourceWorkspace, branchName, worktreePath, branchShouldBeGone, prExpected, originalPrUrl }) {
  // A worktree counts as present if the directory survived on disk OR git still
  // tracks it. Either alone is a leak: an unregistered directory is the full
  // checkout `removeWorktree` believed it deleted, and a registered-but-deleted
  // tree wedges the next `git worktree add` for that path. The cheap disk check
  // first, so the common leaked-directory case skips the `git worktree list` spawn.
  const probeWorktree = async () => {
    // A pathless swarm branch (no completion receipt) is present while any checkout holds it.
    const present = worktreePath ? await readCheckoutPathPresence(worktreePath) : false;
    if (present !== false) return present;
    const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
    if (!worktrees) return null;
    return worktrees.some(wt => (worktreePath ? wt.path === worktreePath : wt.branch?.replace(/^refs\/heads\//, '') === branchName));
  };

  const probeLocalBranch = () => readLocalBranchPresence(sourceWorkspace, branchName);

  // `listRemoteHeads` is branch-reconcile's single answer to "what is on origin
  // right now", already carrying the null-means-could-not-ask contract. It reads
  // `ls-remote` rather than the `refs/remotes/*` mirror, which nothing here fetches.
  const probeRemoteBranch = async () => {
    if (!branchShouldBeGone) return null;
    const heads = await listRemoteHeads(sourceWorkspace).catch(() => null);
    return heads ? heads.has(branchName) : null;
  };

  // Ask whichever forge this remote actually lives on, via the shared probe
  // (`prProbe.js`) — `verifyPrClaim` already owns "the agent never opened
  // one", so there is nothing here to report and nothing missing on a `none`
  // answer.
  const probePr = async () => {
    if (originalPrUrl && branchShouldBeGone) {
      const parsed = parsePullRequestUrl(originalPrUrl);
      const { getOriginInfo } = await import('../lib/gitRemote.js');
      const origin = await getOriginInfo(sourceWorkspace);
      if (!parsed || origin?.host !== parsed.host || origin?.fullName !== `${parsed.owner}/${parsed.repo}`) return { readable: false, prState: null, prUrl: null };
      const probe = await probeChangeRequestState(sourceWorkspace, { number: parsed.number, branch: branchName });
      return { ...probe, prUrl: originalPrUrl, prNumber: parsed.number };
    }
    if (!prExpected || !branchShouldBeGone) return { prState: null, prUrl: null, prNumber: null, cli: null, readable: true };
    return probePrForBranch(sourceWorkspace, branchName);
  };

  // `allowRemote: false` — a bookkeeping question must not block on `git remote
  // set-head origin --auto`, the network call the default path can trigger.
  const probeDefaultBranch = () => (branchShouldBeGone
    ? git.getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null)
    : Promise.resolve(null));

  const [worktreePresent, localBranchPresent, remoteBranchPresent, defaultBranch, pr] = await Promise.all([
    probeWorktree().catch(() => null),
    probeLocalBranch(),
    probeRemoteBranch(),
    probeDefaultBranch(),
    probePr().catch(() => ({ prState: null, prUrl: null, prNumber: null, cli: null, readable: false })),
  ]);

  // Only meaningful while the branch still exists locally.
  // Diagnostics require readable refs before reporting absent merge evidence;
  // otherwise an unreadable repo would produce a false recovery finding.
  const branchMerged = localBranchPresent === true && defaultBranch
    ? await probeBranchMerged(sourceWorkspace, branchName, defaultBranch)
    : null;

  // Which probes that COULD have produced a finding came back unreadable. The
  // caller reports a run with any of these as `probe-incomplete` rather than
  // clean — a probe we never got an answer from has not verified anything, and
  // logging it as a verified repo is the absent-vs-empty conflation this module
  // exists to avoid. A probe that was deliberately skipped (not applicable to
  // this run's end-state shape) is NOT unreadable.
  const unreadable = [];
  if (worktreePresent === null) unreadable.push('worktree');
  if (localBranchPresent === null) unreadable.push('local-branch');
  if (branchShouldBeGone) {
    if (remoteBranchPresent === null) unreadable.push('remote-branch');
    // Merge state is only in question while the branch is still there; once it is
    // gone there is nothing left to be unmerged.
    if (localBranchPresent === true && branchMerged === null) unreadable.push('branch-merged');
    if (prExpected && !pr.readable) unreadable.push('pull-request');
  }

  return {
    worktreePresent,
    localBranchPresent,
    remoteBranchPresent,
    branchMerged,
    prState: pr.prState,
    autoMergeEnabled: pr.autoMergeEnabled === true,
    prUrl: pr.prUrl,
    prNumber: pr.prNumber,
    forgeCli: pr.cli,
    defaultBranch,
    unreadable,
  };
}

/**
 * Verify one completed worktree agent left the repository as its task asked, and
 * file a recovery task when it did not.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {object} params.task - the CoS task
 * @param {object|null} params.agentState - persisted agent record (worktree metadata)
 * @param {boolean} params.success - effective success of the run
 * @param {boolean} [params.prExpected] - the task asked for a PR (`openPR`)
 * @param {string[]} [params.cleanupWarnings] - warnings cleanup already raised
 * @returns {Promise<{verified: boolean, skipReason: string|null, issues: Array<{code: string, message: string}>, observed: object|null, recoveryTaskId: string|null}>}
 */
const verificationRuns = new Map();

export async function verifyAgentRepoState(input) {
  if (verificationRuns.has(input.agentId)) return verificationRuns.get(input.agentId);
  const cleanupPending = input.agentState?.result?.cleanupPending === true;
  const verify = async () => {
    if (input.agentState?.metadata?.completionSentinel
      && await completionSentinelPresent(input.agentId, input.agentState.metadata.workspacePath)) return skipped('completion-sentinel-generation-pending');
    if (input.agentState?.metadata?.checkoutCapture?.status === 'pending') return skipped('checkout-capture-pending');
    if (cleanupPending) {
      const { getTaskById } = await import('./cosTaskStore.js');
      const original = await getTaskById(input.task.id);
      if (!original) return skipped('cleanup-task-unavailable');
      const current = await recoverCompletionTaskHandoff(input.agentState) || original;
      if (current.status !== 'in_progress' || current.metadata?.deliveryRecovery !== 'cleanup'
        || current.metadata.deliveryRecoveryAgentId !== input.agentId) {
        return skipped('cleanup-owner-changed');
      }
      input = { ...input, task: current };
    }
    // Cleanup warnings describe the retained checkout this audit must settle.
    // They cannot suppress the only server-owned cleanup continuation.
    return verifyRunBranches({ ...input, success: input.success || cleanupPending,
      ...(cleanupPending ? { cleanupWarnings: [] } : {}) });
  };
  const run = verify().then(async result => {
    if (result.skipReason === 'cleanup-owner-changed' || result.skipReason === 'cleanup-task-unavailable') return result;
    const outcomes = result.branches || [result];
    const unsupported = prStaysOpen(input.task) ? { skipReason: 'leave-open-cleanup-unsupported' } : outcomes.find(item => [REPO_STATE_SKIPS.DISABLED, REPO_STATE_SKIPS.NOT_WORKTREE,
      REPO_STATE_SKIPS.PERSISTENT_WORKTREE, REPO_STATE_SKIPS.DISCARDED_WORKTREE,
      'retirement-app-unavailable', 'retirement-policy-not-legacy-completed'].includes(item.skipReason)
      || (item.skipReason === 'cleanup-delivery-unverified' && (['OPEN', 'CLOSED'].includes(item.observed?.prState)
        || (item.observed?.prState === null && item.observed?.prUrl === null && item.observed?.unreadable?.length === 0))));
    if (cleanupPending && unsupported) {
      const { resolveUndeliveredTaskUpdate } = await import('./agentErrorAnalysis.js');
      const outcome = { status: 'incomplete', reason: `Cleanup verification cannot run (${unsupported.skipReason}). ${input.task.metadata?.taskOutcome?.reason || ''}`.trim() };
      const planned = resolveUndeliveredTaskUpdate(input.task, outcome, input.agentId);
      const saved = await updateTask(input.task.id, planned, input.task.taskType || 'user', { expectedStatus: 'in_progress',
        expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: input.agentId } });
      if (saved?.status !== planned.status || saved?.error || saved?.statusChanged) return { ...result, skipReason: 'cleanup-transfer-unverified' };
      if (planned.metadata.retryPendingCleanup) {
        const { releaseRetryHold } = await import('./agentWorktreeCleanup.js');
        await releaseRetryHold({ agentId: input.agentId, task: input.task, success: false, agentMetadata: input.agentState.metadata });
      }
      const { recordRepoStateVerification } = await import('./cosAgentLifecycle.js');
      await recordRepoStateVerification(input.agentId, { status: 'completed', reasons: ['cleanup-transferred-to-recovery'] });
      return { ...result, skipReason: 'cleanup-transferred-to-recovery' };
    }
    if (cleanupPending && result.verified) {
      const { recordCompletionCleanup } = await import('./cosAgentLifecycle.js');
      if (input.agentState.metadata?.completionCleanup?.version === 1) {
        const recorded = await recordCompletionCleanup(input.agentId, input.agentState.startedAt, {
          stages: { worktree: { status: 'done', retryable: false, value: [], verifiedBy: 'repository-preservation-receipt' } } });
        if (!recorded) return { ...result, verified: false, skipReason: 'cleanup-ledger-settlement-unverified' };
      }
      const updated = await updateTask(input.task.id, { status: 'completed', metadata: {
        deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined,
        taskOutcome: { status: 'completed', reason: 'Delivery and repository preservation were verified by completion recovery.' },
      } }, input.task.taskType || 'user', { expectedStatus: 'in_progress',
        expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: input.agentId } });
      if (updated?.status !== 'completed' || updated?.error || updated?.statusChanged) return { ...result, verified: false, skipReason: 'cleanup-task-settlement-unverified' };
    }
    // Completion persists pending before publishing its event. A failed probe,
    // active follow-up or refused task write stays pending for the timer sweep.
    if (input.agentState?.metadata?.repoStateVerification?.status === 'pending') {
      const outcomes = result.branches || [result];
      const terminalSkips = [REPO_STATE_SKIPS.DISABLED, REPO_STATE_SKIPS.NOT_WORKTREE,
        REPO_STATE_SKIPS.PERSISTENT_WORKTREE, REPO_STATE_SKIPS.DISCARDED_WORKTREE, REPO_STATE_SKIPS.FAILED_RUN];
      const settled = cleanupPending ? result.verified
        : outcomes.every(item => item.verified || terminalSkips.includes(item.skipReason)) || leavesPrForHuman(input.task);
      const { recordRepoStateVerification } = await import('./cosAgentLifecycle.js');
      await recordRepoStateVerification(input.agentId, { status: settled ? 'completed' : 'pending',
        checkedAt: new Date().toISOString(), reasons: [...new Set(outcomes.map(item => item.skipReason).filter(Boolean))] });
    }
    return result;
  }).finally(() => verificationRuns.delete(input.agentId));
  verificationRuns.set(input.agentId, run);
  return run;
}

/** Wake only this terminal job after its execution entry was released. The
 * periodic bounded sweep remains the durable fallback if the process exits. */
export async function resumeAgentCompletionRetirement(agentId) {
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const agent = await getAgentRecord(agentId);
  if (agent?.status !== 'completed' || agent.result?.cleanupPending !== true
    || agent.metadata?.repoStateVerification?.status !== 'pending') return;
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(agent.taskId);
  if (!task) return;
  const { replayAgentCompletionCleanup } = await import('./agentCompletionCleanup.js');
  await replayAgentCompletionCleanup(agent);
  const current = await getAgentRecord(agentId);
  await verifyAgentRepoState({ agentId, agentState: current, task,
    success: current.result?.success === true, prExpected: isTruthyMeta(task.metadata?.openPR) });
  const settled = await getAgentRecord(agentId);
  await replayAgentCompletionCleanup(settled);
}

let completionSweep = null;
/** Resume interrupted completion from existing agent archives, bounded per pass. */
export function sweepRepoStateVerifications() {
  if (completionSweep) return completionSweep;
  completionSweep = resumeCompletionAudits().finally(() => { completionSweep = null; });
  return completionSweep;
}

async function resumeCompletionAudits() {
  const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
  const { getTaskById } = await import('./cosTaskStore.js');
  const agents = await readBranchCompletionPolicies({ repairIndex: false });
  const { recoverLegacyDeliveryBlocks } = await import('./deliveryRecovery.js');
  await recoverLegacyDeliveryBlocks(agents);
  const lastAttempt = agent => [agent.metadata.repoStateVerification?.checkedAt, agent.metadata.completionCleanup?.updatedAt,
    agent.metadata.completionCleanup?.lastAttemptAt].filter(value => typeof value === 'string').sort().at(-1) || '';
  const pending = agents.filter(agent => agent.status === 'completed' && (agent.metadata?.repoStateVerification?.status === 'pending'
    || agent.metadata?.completionCleanup?.status === 'pending'))
    .sort((a, b) => lastAttempt(a).localeCompare(lastAttempt(b)));
  let checked = 0;
  for (const original of pending.slice(0, 10)) {
    const { recordCompletionCleanup } = await import('./cosAgentLifecycle.js');
    await recordCompletionCleanup(original.id || original.agentId, original.startedAt, { lastAttemptAt: new Date().toISOString() });
    const { replayAgentCompletionCleanup } = await import('./agentCompletionCleanup.js');
    const { getAgentRecord } = await import('./cosAgentLifecycle.js');
    await replayAgentCompletionCleanup(original).catch(error => emitLog('warn', `Completion cleanup deferred for ${original.id}: ${error.message}`, { agentId: original.id }));
    const agent = await getAgentRecord(original.id || original.agentId).catch(() => null) || original;
    const task = await getTaskById(agent.taskId).catch(() => null);
    // Move missing tasks to the back of the next pass; they cannot grant authority.
    if (!task) {
      const { recordRepoStateVerification } = await import('./cosAgentLifecycle.js');
      await recordRepoStateVerification(agent.id || agent.agentId, { status: 'pending',
        checkedAt: new Date().toISOString(), reasons: ['task-unavailable'] });
      checked++;
      continue;
    }
    await verifyAgentRepoState({ agentId: agent.id || agent.agentId, agentState: agent, task,
      success: agent.result?.success === true, prExpected: isTruthyMeta(task.metadata?.openPR) || !!task.metadata?.reviewLoopPRUrl || !!agent.metadata?.reviewLoopMergeTarget?.url })
      .catch(error => emitLog('warn', `Completion recovery deferred for ${agent.id}: ${error.message}`, { agentId: agent.id }));
    const updated = await getAgentRecord(agent.id || agent.agentId).catch(() => null);
    if (updated) await replayAgentCompletionCleanup(updated).catch(error => emitLog('warn', `Completion cleanup deferred for ${agent.id}: ${error.message}`, { agentId: agent.id }));
    checked++;
  }
  return { checked, pendingAtStart: pending.length };
}

const skipped = (skipReason, { issues = [], observed = null } = {}) => ({ verified: false, skipReason, issues, observed, recoveryTaskId: null });

/**
 * The cleanup ledger for one branch. `blockWith` records a hold and returns the
 * matching skip in one step, so a gate cannot return a skip while leaving the
 * ledger silent about the branch it held. `skipReason` overrides the returned
 * reason only where the caller-facing skip code differs from the ledger reason.
 *
 * @param {string} agentId
 * @param {{branch: string, path?: string}} location - stamped on every ledger entry
 */
function branchLedger(agentId, location) {
  const record = async (status, reason, extra = {}) => {
    const { recordCleanupOutcome } = await import('./cosAgentLifecycle.js');
    return recordCleanupOutcome(agentId, { status, reason, ...location, ...extra });
  };
  const blockWith = async (reason, { skipReason = reason, record: extra, issues, observed } = {}) => {
    await record('blocked', reason, extra);
    return skipped(skipReason, { issues, observed });
  };
  return { record, blockWith };
}

async function verifyRunBranches(input) {
  const meta = input.agentState?.metadata || {};
  if (meta.isWorktree === true || !hasClaimCheckoutBindings(meta)) return verifyAgentBranchState(input);
  const bindings = [meta.claimBranches, meta.claimReleasedBranches];
  if (bindings.some(value => value != null && (!Array.isArray(value) || value.some(branch => typeof branch !== 'string' || !branch)))) {
    return skipped(REPO_STATE_SKIPS.GATE_UNREADABLE);
  }
  const branches = [...new Set(bindings.flatMap(value => value || []))];
  if (!branches.length) return verifyAgentBranchState(input);
  const sourceWorkspace = meta.sourceWorkspace || meta.workspacePath;
  const trees = sourceWorkspace ? await listWorktrees(sourceWorkspace).catch(() => null) : null;
  if (!trees) return skipped(REPO_STATE_SKIPS.GATE_UNREADABLE);
  const holdBranch = async (branch, reason, extra) => {
    // Per-branch swarm results carry no observation; a held branch was never probed.
    const { observed: _unprobed, ...held } = await branchLedger(input.agentId, { branch }).blockWith(reason, { record: extra });
    return { branch, ...held };
  };
  const results = [];
  for (const branch of branches) {
    const { readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
    const { claimCheckoutOwner } = await import('../lib/claimContinuation.js');
    const agents = await readClaimOwnershipAgents().catch(() => null);
    const owner = claimCheckoutOwner({ branchName: branch, sourceWorkspace, agents });
    if (owner) {
      results.push(await holdBranch(branch, owner.reason, { owners: owner.owners }));
      continue;
    }
    // A current branch holder is not evidence of the old claim's checkout.
    // Only the server's completion capture names its original incarnation.
    const original = meta.completedCheckouts?.find(row => row.branch === branch);
    // With no checkout and no local ref left, there is no incarnation to confuse:
    // only the delivery evidence remains to settle.
    const absent = !original?.path && !trees.some(tree => tree.branch?.replace(/^refs\/heads\//, '') === branch)
      && await readLocalBranchPresence(sourceWorkspace, branch).catch(() => null) === false;
    if (!original?.path && !absent) {
      results.push(await holdBranch(branch, 'claim-checkout-identity-unverified'));
      continue;
    }
    results.push({ branch, ...await verifyAgentBranchState({ ...input, prExpected: true,
      agentState: { ...input.agentState, metadata: { ...meta, isWorktree: true,
        worktreeBranch: branch, sourceWorkspace, workspacePath: original?.path ?? null } },
    }) });
  }
  return { verified: results.every(result => result.verified), branches: results,
    issues: results.flatMap(result => result.issues), skipReason: null };
}

async function verifyAgentBranchState({ agentId, task, agentState, success, prExpected = false, cleanupWarnings = [] }) {
  const metadata = agentState?.metadata || {};
  const branchName = metadata.worktreeBranch || null;
  const sourceWorkspace = metadata.sourceWorkspace || null;
  const appId = task?.metadata?.app || null;

  // Resolved twice on purpose. The first pass applies every FREE gate; only a run
  // that survives all of them pays for the pending-owner answer (two task-file
  // reads plus the app record) that the second pass needs. One gate ladder, in
  // one place, still decides.
  const structural = {
    enabled: true,
    success,
    isWorktree: metadata.isWorktree === true,
    isPersistentWorktree: metadata.isPersistentWorktree === true,
    discardWorktree: isTruthyMeta(task?.metadata?.discardWorktree),
    cleanupWarningCount: cleanupWarnings?.length || 0,
    prCompletion: resolvePrCompletion(task?.metadata),
    leaveOpen: leavesPrForHuman(task),
    prExpected,
    branchName,
    sourceWorkspace,
  };
  const preflight = resolveRepoStateExpectation(structural);
  if (!preflight.verify) return skipped(preflight.skipReason);

  // Both reads below fail CLOSED. `getAppById` answers `null` for "no such app"
  // AND throws for "could not read apps.json", and collapsing those would let a
  // transient read failure override an explicit per-app opt-out; likewise an
  // unreadable task queue must not read as "nobody owns this branch".
  const UNREADABLE = Symbol('unreadable');
  const app = appId
    ? await (await import('./apps.js')).getAppById(appId).catch(() => UNREADABLE)
    : null;
  if (app === UNREADABLE) return skipped(REPO_STATE_SKIPS.GATE_UNREADABLE);

  const worktreePath = isClaimAgentMetadata(metadata) ? metadata.workspacePath : metadata.workspacePath || join(PATHS.worktrees, agentId);
  const { record, blockWith } = branchLedger(agentId, { branch: branchName, path: worktreePath });
  const enabled = repoStateVerificationEnabled(app);
  const owned = enabled ? await branchHasPendingOwner(branchName, app, agentState?.result?.cleanupPending === true ? { taskId: task.id, agentId } : null).catch(() => null) : false;
  if (owned === null) return blockWith('ownership-unreadable', { skipReason: REPO_STATE_SKIPS.GATE_UNREADABLE });
  if (owned) await record('pending', 'existing-completion-owner');

  const originalPrUrl = [metadata.reviewLoopMergeTarget?.url, metadata.recoveryMergeTarget?.url,
    task?.metadata?.reviewLoopPRUrl, task?.metadata?.recoveryMergeTarget?.url].find(value => parsePullRequestUrl(value));
  const expectation = resolveRepoStateExpectation({ ...structural, prExpected: prExpected || !!originalPrUrl, enabled, followUpPending: owned });
  if (!expectation.verify) return skipped(expectation.skipReason);

  const hold = await resolveCheckoutIncarnation({ metadata, sourceWorkspace, branchName, worktreePath });
  if (hold) return blockWith(hold.reason, { record: hold.record });
  const observed = await probeRepoState({
    sourceWorkspace,
    branchName,
    worktreePath,
    branchShouldBeGone: !expectation.staysOpen,
    prExpected: expectation.prExpected, originalPrUrl,
  }).catch(err => {
    emitLog('warn', `🔎 Repo-state probe failed for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  if (!observed) return blockWith('probe-incomplete', { skipReason: REPO_STATE_SKIPS.PROBE_INCOMPLETE });

  if (observed.worktreePresent === false && observed.localBranchPresent === false) {
    return settleAbsentCheckout({ agentId, agentState, metadata, app, sourceWorkspace, branchName, worktreePath, originalPrUrl, observed, record, staysOpen: expectation.staysOpen });
  }
  const issues = classifyRepoStateIssues(expectation, { ...observed, branchName });
  if (issues.length === 0) {
    // A run where some probe could not be read has not been verified — it has been
    // partially checked. Say so rather than logging a firewalled host as a clean
    // repo. Findings still stand on their own: what WAS readable is fact, so a
    // divergence below is reported even alongside an unreadable probe.
    if (observed.unreadable.length > 0) {
      emitLog('info', `🔎 Repo state only partly readable for ${agentId} (${branchName}) — could not check: ${observed.unreadable.join(', ')}`, { agentId, branchName });
      return blockWith('probe-incomplete', { skipReason: REPO_STATE_SKIPS.PROBE_INCOMPLETE, observed });
    }
    emitLog('info', `🔎 Agent branch ${branchName} verified clean for ${agentId}`, { agentId, branchName });
    return { verified: true, skipReason: null, issues: [], observed, recoveryTaskId: null };
  }

  if (resolvePrCompletion(task?.metadata) === PR_COMPLETIONS.LEAVE_OPEN) {
    emitLog('warn', `Review-only branch ${branchName} needs attention; automatic cleanup and recovery suppressed`, { agentId, branchName });
    return skipped(null, { issues, observed });
  }

  return settleDivergedBranch({ agentId, task, agentState, app, appId, metadata, sourceWorkspace, branchName, worktreePath,
    observed, issues, record, blockWith });
}

/**
 * A reused branch is not the old checkout. No model is needed to identify a
 * different holder, and its live work must never become this parent's target.
 *
 * @returns {Promise<{reason: string, record?: object}|null>} the hold, or null when this run still owns the checkout
 */
async function resolveCheckoutIncarnation({ metadata, sourceWorkspace, branchName, worktreePath }) {
  const inventory = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!inventory) return { reason: 'checkout-inventory-unavailable' };
  const holders = inventory.filter(tree => tree.branch?.replace(/^refs\/heads\//, '') === branchName);
  // Git porcelain uses forward slashes on Windows; registration spelling is
  // not an incarnation change. Resolve only native lexical path syntax here;
  // the persisted pointer/private-administration identity is still checked below.
  const samePath = tree => resolve(tree.path) === resolve(worktreePath);
  const pathHolder = inventory.find(samePath);
  if (holders.some(tree => !samePath(tree))
    || (pathHolder && pathHolder.branch?.replace(/^refs\/heads\//, '') !== branchName)) {
    return { reason: 'checkout-incarnation-changed' };
  }
  const completed = metadata.completedCheckouts?.find(row => row.branch === branchName && resolve(row.path) === resolve(worktreePath));
  if (completed && pathHolder) {
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const identity = await readCompletedCheckoutIdentity({ repoPath: sourceWorkspace, branch: branchName,
      path: worktreePath, head: pathHolder.head }).catch(() => null);
    if (!identity || identity.head !== completed.head || JSON.stringify(identity.incarnation) !== JSON.stringify(completed.incarnation)) {
      return { reason: 'checkout-incarnation-changed' };
    }
  }
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
  const { claimCheckoutOwner } = await import('../lib/claimContinuation.js');
  const owner = claimCheckoutOwner({ branchName, sourceWorkspace,
    agents: await readClaimOwnershipAgents().catch(() => null) });
  return owner ? { reason: owner.reason, record: { owners: owner.owners } } : null;
}

/**
 * Missing originals are an accounting gap, not a reason to hire an agent
 * to rediscover absence. Never invent a preservation receipt.
 */
async function settleAbsentCheckout({ agentId, agentState, metadata, app, sourceWorkspace, branchName, worktreePath, originalPrUrl, observed, record, staysOpen }) {
  const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
  const proofUrl = originalPrUrl || observed.prUrl;
  const forge = proofUrl && observed.prState === 'MERGED' ? await readRetirementForgeEvidence(sourceWorkspace, branchName, proofUrl,
    { forgeAccount: app?.forgeAccount ?? null }).catch(() => null) : null;
  const integrated = forge && (await execGit(['merge-base', '--is-ancestor', forge.prHead, forge.defaultHead], sourceWorkspace,
    { ignoreExitCode: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } }).catch(() => null))?.exitCode === 0;
  const completed = metadata.completedCheckouts?.find(row => [1, 2].includes(row.version) && row.agentId === agentId
    && row.repoPath === sourceWorkspace && row.branch === branchName && row.path === worktreePath
    && Number.isFinite(Date.parse(row.startedAt)) && Date.parse(row.capturedAt) >= Date.parse(row.startedAt));
  if (completed?.version === 2) {
    const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
    if (!completedCheckoutReceiptValid(agentState, completed)) return skipped('checkout-capture-unverified');
  }
  if (!staysOpen && integrated && completed && completed.head === forge.prHead && observed.remoteBranchPresent === false) {
    const { findMissingCheckoutPreservation } = await import('./heldCheckoutRecovery.js');
    const release = { branch: branchName, path: worktreePath, head: completed.head,
      locked: false, lockReason: null, createdAt: completed.capturedAt };
    const proof = await findMissingCheckoutPreservation({ repoPath: sourceWorkspace, release }).catch(() => null);
    if (proof) {
      const { withClaimOwnershipLock } = await import('./cosClaimOwnership.js');
      const verified = await withClaimOwnershipLock(async () => {
        if (await resolveCheckoutIncarnation({ metadata, sourceWorkspace, branchName, worktreePath }) || !await proof.recheck()) return false;
        const { recheck: _recheck, ...evidence } = proof;
        const saved = await record('verified', 'already-absent-preservation-verified', { head: completed.head,
          prUrl: proofUrl, committedIntegrationVerified: true,
          preservation: { ...evidence, capturedAt: completed.capturedAt, verifiedAt: new Date().toISOString() } });
        return saved === true;
      }).catch(() => false);
      if (verified) return { verified: true, skipReason: null, issues: [], observed, recoveryTaskId: null };
    }
  }
  const reason = integrated ? 'already-absent-preservation-unverified' : 'absent-checkout-integration-unverified';
  await record(integrated ? 'already-absent' : 'blocked', reason, { prUrl: originalPrUrl, committedIntegrationVerified: !!integrated });
  return skipped(reason);
}

/**
 * The branch diverged from its expected end state. A merged checkout goes
 * through the retirement gate; anything else is an undelivered branch.
 */
async function settleDivergedBranch(ctx) {
  const { agentId, app, sourceWorkspace, branchName, worktreePath, observed, issues, blockWith } = ctx;
  if (observed.prState !== 'MERGED' || !(observed.worktreePresent || observed.localBranchPresent)) {
    return settleUndeliveredBranch(ctx);
  }
  const prepared = await prepareRecoveryRetirement({ agentId, app, sourceWorkspace, branchName, worktreePath, observed })
    .catch(() => ({ reason: 'retirement-review-unavailable' }));
  if (!prepared.retirement) {
    const held = await blockWith(prepared.reason, { issues, observed });
    // The retirement gate declining is its designed outcome; the reason is recorded on the ledger above.
    emitLog('info', `⏸️ Repo-state retirement retained ${branchName}: ${prepared.reason}`, { agentId, branchName });
    return held;
  }
  if (prepared.integrated) return retireIntegratedCheckout(ctx, prepared.retirement);
  return fileDivergenceRecovery(ctx, prepared.retirement);
}

async function retireIntegratedCheckout({ appId, observed, issues, record, blockWith }, retirement) {
  const { retireInventoriedCheckout } = await import('./heldCheckoutRecovery.js');
  const { assertAutomaticRetirementAllowed } = await import('./branchReconcileRetirement.js');
  const result = await retireInventoriedCheckout({ appId, release: retirement.release,
    review: { prUrl: retirement.prUrl, digest: retirement.digest, acceptSuperseded: false } }, { beforeMutation: assertAutomaticRetirementAllowed }).catch(error => ({ reason: ['daemon-stopped', 'automatic-retirement-disabled'].includes(error.message) ? error.message : 'retirement-outcome-uncertain' }));
  if (!result.ok || !result.archiveDir || result.branchDeleted !== true) {
    return blockWith(result.reason || 'retirement-receipt-unverified', { issues, observed });
  }
  await record('verified', 'retirement-receipt-verified', { prUrl: observed.prUrl, committedIntegrationVerified: true,
    preservation: { archiveDir: result.archiveDir, verifiedAt: new Date().toISOString() } });
  return { verified: true, skipReason: null, issues: [], observed, recoveryTaskId: null };
}

/**
 * Cleanup bookkeeping/unknown forge/CI waits remain deterministic. Only
 * source/history judgment or an actual undelivered branch needs cognition.
 */
async function settleUndeliveredBranch({ agentId, app, sourceWorkspace, branchName, worktreePath, observed, issues, record, blockWith, agentState }) {
  if (agentState?.result?.cleanupPending === true) return blockWith('cleanup-delivery-unverified', { issues, observed });
  if (!issues.some(issue => issue.code === REPO_STATE_ISSUES.BRANCH_UNMERGED || issue.code === REPO_STATE_ISSUES.PR_UNMERGED)) {
    return blockWith('deterministic-cleanup-pending', { issues, observed });
  }
  if (!observed.prState || observed.unreadable.length) return blockWith('delivery-evidence-unavailable', { issues, observed });
  const forgeAccount = app?.forgeAccount ?? null;
  const delivery = observed.prState === 'OPEN'
    ? await inspectOpenDeliveryRepair(sourceWorkspace, branchName, observed.prUrl, { forgeAccount }).catch(() => ({ reason: 'delivery-evidence-unavailable' }))
    : { reason: 'delivery-not-open' };
  let review = null;
  if (delivery.headSha) {
    const { inspectOrQueueCompletedReview } = await import('./repoCleanupRecovery.js');
    review = await inspectOrQueueCompletedReview({ agentId, repoPath: sourceWorkspace, branch: branchName,
      prUrl: observed.prUrl, headSha: delivery.headSha, worktreePath, forgeAccount, repairEvidence: delivery.evidence }).catch(() => ({ disposition: 'held', reason: 'completed-review-inspection-unavailable' }));
  }
  if (review?.disposition === 'queued-review') {
    await record('pending', review.reason, { taskId: review.taskId });
    return { verified: false, skipReason: review.reason, issues, observed, recoveryTaskId: review.taskId };
  }
  return blockWith(review?.reason || delivery.reason || 'completed-review-target-unverified', { issues, observed });
}

async function fileDivergenceRecovery({ agentId, task, appId, metadata, sourceWorkspace, branchName, worktreePath, observed, issues }, retirement) {
  // The recovery task filed below is the investigation, so this line only records the divergence; filing failures still warn.
  emitLog('info', `🔎 Repo state diverged after ${agentId}: ${issues.map(i => i.code).join(', ')}`, { agentId, branchName, taskId: task?.id });

  const recoveryTaskId = await fileRepoStateRecoveryTask({
    agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId, retirement, claimRun: isClaimAgentMetadata(metadata),
  }).catch(err => {
    emitLog('warn', `Failed to file repo-state recovery task for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  if (recoveryTaskId) {
    await ensureTaskThread({
      taskId: recoveryTaskId,
      title: `${RECOVERY_TASK_PREFIX} Finish incomplete cleanup for branch ${branchName}`,
      nextAction: 'Let the recovery task finish, then verify the branch and worktree are clean.',
      notes: issues.map(issue => issue.message).join('\n'),
      priority: 'high',
    }).catch(err => emitLog('warn', `Failed to create repo-state Brain thread for ${branchName}: ${err.message}`, { agentId, branchName }));
  }

  return { verified: false, skipReason: null, issues, observed, recoveryTaskId };
}

/** Persist the exact obligation before preview, so refusal or restart cannot
 * lose it. The preview supplies evidence for review, never deletion authority.
 */
async function prepareRecoveryRetirement({ agentId, app, sourceWorkspace, branchName, worktreePath, observed }) {
  if (!app?.id || !app.repoPath || resolve(app.repoPath) !== resolve(sourceWorkspace)) return { reason: 'retirement-app-unavailable' };
  const trees = await listWorktrees(sourceWorkspace);
  const matches = trees.filter(tree => tree.branch?.replace(/^refs\/heads\//, '') === branchName
    && (!worktreePath || resolve(tree.path) === resolve(worktreePath)));
  if (matches.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(matches[0].head || '')) {
    return { reason: 'retirement-exact-inventory-unavailable' };
  }
  const tree = matches[0];
  const checkoutIdentity = await readRetirementCheckoutIdentity(tree.path);
  const release = { branch: branchName, path: worktreePath || tree.path, head: tree.head,
    ...(checkoutIdentity && { checkoutIdentity, observedAt: new Date().toISOString() }),
    locked: tree.locked === true, lockReason: tree.lockReason ?? null };
  const { recordBranchReconcileOutcome } = await import('./taskSchedule.js');
  const outcome = await recordBranchReconcileOutcome(app.id, { status: 'incomplete', reason: 'retirement-review-pending',
    retirementObligations: [{ ...release, reason: 'retirement-review-pending' }],
    nextAction: 'Review this exact checkout through the retirement API; require its verified archive receipt.' });
  const obligation = outcome?.retirementObligations?.find(row => sameRetirementObservation(row, release));
  if (!obligation?.createdAt) return { reason: 'retirement-obligation-unavailable' };
  // Terminal ingestion releases the registry verdict before every spawn path
  // has finished teardown. Preserve the durable obligation until its exact
  // execution owner has actually left the local active maps.
  const { getActiveAgentIds } = await import('./agentState.js');
  if (getActiveAgentIds().includes(agentId)) return { reason: 'completion-execution-active' };
  if (release.locked) {
    await recordBranchReconcileOutcome(app.id, { status: 'incomplete', reason: 'retirement-worktree-locked',
      nextAction: 'Keep the checkout locked; its owner must explicitly release it before another preview.' });
    return { reason: 'retirement-worktree-locked' };
  }
  const { prepareInventoriedCheckoutRetirement } = await import('./heldCheckoutRecovery.js');
  const prepared = await prepareInventoriedCheckoutRetirement({ appId: app.id, release, prUrl: observed.prUrl });
  if (!prepared.ok) {
    await recordBranchReconcileOutcome(app.id, { status: 'incomplete', reason: prepared.reason,
      nextAction: 'Retain the checkout and obligation; retry a fresh preview after the reported hold resolves.' });
    return { reason: prepared.reason };
  }
  if (!['integrated', 'review-supersession'].includes(prepared.review?.comparison?.disposition)
    || typeof prepared.review.comparison.localPatch !== 'string' || typeof prepared.review.comparison.difference !== 'string') return { reason: 'retirement-comparison-unavailable' };
  return { integrated: prepared.review.forge?.prHead === release.head && prepared.review.comparison?.disposition === 'integrated' && prepared.review.comparison.difference === '',
    retirement: { release, createdAt: obligation.createdAt, prUrl: observed.prUrl, digest: prepared.review.digest,
      cognition: (await import('./branchReconcileRetirement.js')).retirementCognitiveIdentity(prepared.review, release, observed.prUrl) } };
}

/**
 * The remediation step for each issue code, as an instruction the recovery agent
 * can follow without re-deriving the diagnosis.
 *
 * A map rather than a switch with a `default`, so a new code cannot ship without
 * one — `repoStateExpectations.test.js` asserts the two key sets match.
 * `PR_UNMERGED` delegates to branch-reconcile's `driveToMerge`, which carries the
 * caveats a hand-written line loses: preserve the linked checkout (gh can implicitly delete a
 * branch checked out elsewhere), retry `--squash`/`--rebase` on "not allowed",
 * verify the exact-head server handoff and preserve the checkout for API review.
 */
export const REPO_STATE_REMEDIATIONS = Object.freeze({
  [REPO_STATE_ISSUES.WORKTREE_PRESENT]: ({ worktreePath }) =>
    `Keep the retained worktree ${worktreePath} intact. Use only the exact inventory, full preview review and digest-bound retirement API described below; preserve every tracked, untracked, ignored and private Git artifact.`,
  [REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT]: ({ branchName }) =>
    `Keep local branch ${branchName} until the retirement service returns its exact verified archive receipt. Missing checkout or merged status is not permission for shell deletion.`,
  [REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT]: ({ branchName }) =>
    `Leave remote branch ${branchName} to the service's fresh exact-head cleanup. An advanced or unreadable ref is a hold; do not use a generic delete API or merge deletion flag.`,
  [REPO_STATE_ISSUES.BRANCH_UNMERGED]: ({ base }) =>
    `The branch has work not proven integrated in ${base}. Inspect whether it remains wanted, finish its draft PR, review and required checks, then complete the authorized merge. Preserve all unmerged or superseded work for explicit review; do not merge into the primary checkout or discard it.`,
  // Forge-aware: `driveToMerge` emits a `gh pr merge` procedure, which a GitLab
  // recovery agent cannot run. Its non-gh caveats still apply on either forge —
  // merge from the repo ROOT and preserve all checkout/ref evidence.
  [REPO_STATE_ISSUES.PR_UNMERGED]: ({ prUrl, prNumber, forgeCli }) => (forgeCli === 'glab'
    ? `Finish the merge request${prUrl ? ` ${prUrl}` : ''}: fix failing pipeline jobs and resolve review threads, retain delivery ownership until required checks and reviews pass, revalidate its exact reviewed head under merge admission, then merge from the repo ROOT with "glab mr merge ${prNumber ?? '<iid>'} --yes" while preserving source branches and checkouts. Confirm MERGED and release admission; never request source-branch deletion during merge.`
    : `Finish the pull request${prUrl ? ` ${prUrl}` : ''}. ${driveToMerge(prUrl || '<num>')}`),
});

/**
 * File ONE recovery task covering every issue found for this branch.
 *
 * Dedup rides on `addTask`'s first-line + app matching: the description names the
 * branch, so a re-run of the same audit joins the existing task rather than
 * stacking a second one.
 *
 * @returns {Promise<string|null>} the task id, or null when it was a duplicate
 */
async function fileRepoStateRecoveryTask({ agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId, retirement = null, claimRun = false }) {
  const appName = task?.metadata?.appName || appId || 'PortOS';
  const base = observed.defaultBranch || 'the default branch';
  const ctx = { branchName, base, prUrl: observed.prUrl, prNumber: observed.prNumber, worktreePath, forgeCli: observed.forgeCli };

  const retirementInstructions = retirement
    ? (await import('./branchReconcileRetirement.js')).retirementReviewInstructions({ branch: branchName, retirement }, appId)
    : `After confirming MERGED and releasing admission, request branch-reconcile through POST /api/cos/schedule/trigger with ${JSON.stringify({ taskType: 'branch-reconcile', appId })} using authenticated PortOS transport. Keep checkout and refs for its exact inventory/review/retire workflow; report cleanup pending until the archive receipt exists.`;
  const context = [
    'An agent finished successfully but the repository did not end up in the expected state.',
    '',
    `Repository: ${sourceWorkspace}`,
    `Branch: ${branchName}`,
    `Worktree: ${worktreePath}`,
    `Default branch: ${base}`,
    observed.prUrl ? `Change request: ${observed.prUrl} (${observed.prState || 'state unknown'})` : 'Change request: none found',
    `Original agent: ${agentId}`,
    `Original task: ${task?.description || 'unknown'}`,
    '',
    'What diverged:',
    ...issues.map((i, n) => `${n + 1}. ${i.message}`),
    '',
    MANAGED_WORKTREE_CLEANUP_CONTRACT,
    '',
    'Finish delivery before retirement; retain anything whose evidence or ownership is uncertain:',
    ...issues.map((i, n) => `${n + 1}. ${REPO_STATE_REMEDIATIONS[i.code](ctx)}`),
    '',
    retirementInstructions,
    '',
    `Rules: preserve wanted unmerged work until it is delivered. Retirement requires service-verified integration in ${base} or explicitly reviewed supersession, plus exact digest and complete archive verification. `
      + `Other agents are running concurrently with their own worktrees and branches; touch ONLY ${branchName} and its worktree. `
      + `Do not switch branches in ${sourceWorkspace} itself.`,
  ].join('\n');

  const head = await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace)
    .then(result => result.exitCode === 0 ? result.stdout.trim() : null).catch(() => null);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head || '')
    || (retirement && retirement.release.head !== head)) return null;
  const observation = retirement?.cognition?.observation || processAuditFingerprint({ branchName, worktreePath, head, prUrl: observed.prUrl,
    codes: issues.map(issue => issue.code).sort(), merged: observed.branchMerged,
    remotePresent: observed.remoteBranchPresent, prState: observed.prState, deliveryRepair: observed.deliveryRepair,
    // Stable observation: periodic checks alone do not create new work.
    work: 'delivery-repair' });
  const { reserveRepoCleanupRecovery, recordRepoCleanupRecovery, recordCleanupOutcome } = await import('./cosAgentLifecycle.js');
  const recoveryOwner = retirement?.cognition?.ownerAgentId || agentId;
  const reservation = await reserveRepoCleanupRecovery(recoveryOwner, branchName, observation);
  if (!reservation?.admitted) {
    await recordCleanupOutcome(agentId, { status: 'blocked', reason: reservation?.reason || 'cleanup-observation-unavailable', branch: branchName, path: worktreePath });
    return null;
  }

  // The PR this recovery may land under merge admission (#12251): the forge's
  // own answer for this branch, never the agent's report or the task prose.
  const mergeTarget = issues.some(issue => issue.code === REPO_STATE_ISSUES.PR_UNMERGED) && parsePullRequestUrl(observed.prUrl)
    ? { url: observed.prUrl, branch: branchName } : null;
  const created = await addTask({
    description: `${RECOVERY_TASK_PREFIX} Finish incomplete cleanup for branch ${branchName} in ${appName}`,
    priority: 'HIGH',
    app: appId || undefined,
    isRecovery: true,
    metadata: { recoveryOrigin: { parentAgentId: agentId, parentTaskId: task?.id || null,
      subsystem: 'repository-cleanup', attempt: reservation.attempt,
      observation, noProgress: false },
    ...(mergeTarget ? { recoveryMergeTarget: mergeTarget } : {}),
    ...(retirement ? { retirementReview: { appId, release: retirement.release, createdAt: retirement.createdAt } } : {}) },
    context,
    useWorktree: false,
  }, 'user');

  await recordRepoCleanupRecovery(recoveryOwner, branchName, observation, { phase: created?.id ? 'dispatched' : 'blocked', taskId: created?.id || null });
  await recordCleanupOutcome(agentId, { status: 'pending', reason: 'cognitive-review-pending', branch: branchName, path: worktreePath, taskId: created?.id || null });
  if (created?.duplicate) {
    emitLog('info', `🔎 Repo-state recovery for ${branchName} already queued as ${created.id}`, { agentId, branchName });
    // Repair an interruption between task creation and backlink persistence,
    // but never bind an unrelated task returned by description deduplication.
    const { getTaskById } = await import('./cosTaskStore.js');
    const duplicate = await getTaskById(created.id).catch(() => null);
    const origin = duplicate?.metadata?.recoveryOrigin;
    const target = duplicate?.metadata?.recoveryMergeTarget;
    if (!mergeTarget || origin?.parentAgentId !== agentId || origin?.parentTaskId !== task?.id
      || origin?.subsystem !== 'repository-cleanup' || target?.url !== mergeTarget.url || target?.branch !== branchName) return null;
  }
  if (mergeTarget && created?.id) {
    // Admission's trust anchor: task metadata is API-writable, so only this
    // server-written backlink on the parent names which task may land its PR.
    const { recordRepoStateRecovery } = await import('./cosAgentLifecycle.js');
    const bound = await recordRepoStateRecovery(agentId, { taskId: created.id, ...mergeTarget }, { claimRun })
      .catch(error => { emitLog('warn', `Could not bind repo-state recovery to ${agentId}: ${error.message}`, { agentId, branchName }); return null; });
    if (!bound) emitLog('warn', `Repo-state recovery ${created.id} cannot merge ${branchName}: parent ${agentId} was not bound`, { agentId, branchName });
  }
  emitLog('info', `🔧 Filed repo-state recovery task for ${branchName} (${issues.length} issue(s))`, { agentId, branchName, appName });
  return created?.id || null;
}
