import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { canonicalizePath } from '../../lib/pathContainment.js';
import { hasClaimFlowContract } from '../../lib/claimFlowTaskTypes.js';
import { readGitCommonDirectory } from '../../lib/gitRepositoryIdentity.js';
import { recoverCompletionTaskHandoff } from './agentCompletionTaskHandoff.js';
import { getDeliveryActivity, withDeliveryActivity } from './agentDeliveryActivity.js';
import { MANAGED_WORKTREE_CLEANUP_CONTRACT } from '../../lib/mergeGateContract.js';
import { processAuditFingerprint } from '../../lib/persistent/persistentMindProcessAudit.js';
import { hasClaimCheckoutBindings, readCompletedCheckoutIdentity, isGitCommitSha, shortBranch, findValidCheckoutCaptures } from '../completedCheckoutEvidence.js';
import { resolveRetirementApp } from '../retirementAppScope.js';
import { createRepoStateSweep } from './agentRepoStateSweep.js';
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
 * the recovery agent cannot substitute shell deletion for the direct branch-reconcile removal.
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

import { readLocalBranchPresence, readCheckoutPathPresence, inspectOpenDeliveryRepair } from '../repoCleanupObservation.js';
import { repositoryCleanupRecoveryMetadata } from '../cleanupOnlyCompletion.js';
import { join, resolve } from 'path';
import { cosEvents, emitLog } from '../cos/cosEvents.js';
import { addTask, updateTask, getTaskById } from '../cos/cosTaskStore.js';
import { getDefaultBranch } from '../git/status.js';
import { hasBranchMergeEvidence } from '../git/branchEvidence.js';
import { listWorktrees } from '../worktreeManager.js';
import { listRemoteHeads, driveToMerge } from '../branchReconcile.js';
import { isMergeHandoffEnabled } from '../../lib/mergeGateContract.js';
import { readAllTasksFlat } from '../investigationTaskProducer.js';
import { execGit } from '../../lib/execGit.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isTruthyMeta } from './agentState.js';
import { RECOVERY_TASK_PREFIX } from '../recoveryTasks.js';
import { resolveTaskTargetBranch } from '../../lib/taskTargetBranch.js';
import { leavesPrForHuman, prStaysOpen, resolvePrCompletion, PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { probePrForBranch, probeChangeRequestState } from '../prProbe.js';
import { parsePullRequestUrl } from '../../lib/gitForge.js';
import {
  REPO_STATE_ISSUES,
  REPO_STATE_SKIPS,
  classifyRepoStateIssues,
  repoStateVerificationEnabled,
  resolveRepoStateExpectation,
} from '../../lib/repoStateExpectations.js';
import { getOriginInfo } from '../../lib/gitRemote.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents } from '../cos/cosClaimOwnership.js';
import { getInstanceId } from '../instanceIdentity.js';
import { claimCheckoutOwner } from '../../lib/claimContinuation.js';
import { loadState } from '../cos/cosState.js';
import { COMPLETION_RECEIPT_VERSION, COMPLETION_STAGE, REPOSITORY_HOLD, completionReceiptDone,
  completionWaitingOnRepository, verifiedRepositoryWorktreeStage } from '../../lib/agent/agentCompletionStages.js';

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
async function branchHasPendingOwner(branchName, sourceWorkspace, app, cleanupOwner = null) {
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
  const candidates = tasks.filter(t =>
    !(cleanupOwner && t.id === cleanupOwner.taskId && t.metadata?.deliveryRecovery === 'cleanup'
      && t.metadata.deliveryRecoveryAgentId === cleanupOwner.agentId)
    && PENDING_OWNER_STATUSES.has(t.status) && resolveTaskTargetBranch(t.metadata) === branchName
  );
  if (candidates.length) {
    const common = await readGitCommonDirectory(sourceWorkspace);
    if (!common) return null;
    const { getAppById } = await import('../apps.js');
    // Audit-local only: each candidate app is read once, with no stale identity
    // carried into another audit. Different app IDs are not different repos.
    const identities = new Map();
    for (const candidate of candidates) {
      const appId = candidate.metadata?.app;
      if (!appId) return null;
      if (!identities.has(appId)) {
        const ownerApp = await getAppById(appId).catch(() => null);
        identities.set(appId, await readGitCommonDirectory(ownerApp?.repoPath));
      }
      const ownerCommon = identities.get(appId);
      if (!ownerCommon) return null;
      if (ownerCommon === common) return true;
    }
  }

  if (!app) return false;
  const { readPendingMergePrs } = await import('../prWatcher.js');
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
  return hasBranchMergeEvidence(repoPath, branch, target).catch(() => null);
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
 * @param {{kind: 'exact-target', url: string} | {kind: 'branch'} | {kind: 'skip'}} params.prProbe
 * @returns {Promise<{worktreePresent: boolean|null, localBranchPresent: boolean|null, remoteBranchPresent: boolean|null, branchMerged: boolean|null, prState: string|null, prUrl: string|null, defaultBranch: string|null}>}
 */
async function probeRepoState({ sourceWorkspace, branchName, worktreePath, branchShouldBeGone, prProbe }) {
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
    return worktrees.some(wt => (worktreePath ? wt.path === worktreePath : shortBranch(wt.branch) === branchName));
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
    if (prProbe.kind === 'exact-target') {
      const parsed = parsePullRequestUrl(prProbe.url);
      const origin = await getOriginInfo(sourceWorkspace);
      if (!parsed || origin?.host !== parsed.host || origin?.fullName !== `${parsed.owner}/${parsed.repo}`) return { readable: false, prState: null, prUrl: null };
      const probe = await probeChangeRequestState(sourceWorkspace, { number: parsed.number, branch: branchName });
      return { ...probe, prUrl: prProbe.url, prNumber: parsed.number };
    }
    if (prProbe.kind === 'skip') return { prState: null, prUrl: null, prNumber: null, cli: null, readable: true };
    return probePrForBranch(sourceWorkspace, branchName);
  };

  // `allowRemote: false` — a bookkeeping question must not block on `git remote
  // set-head origin --auto`, the network call the default path can trigger.
  const probeDefaultBranch = () => (branchShouldBeGone
    ? getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null)
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
  }
  if (prProbe.kind !== 'skip' && !pr.readable) unreadable.push('pull-request');

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

const verificationRuns = new Map();
// Events emitted by an explicit cleanup-only recheck must not start another
// completion replay. Unrelated events retain their normal wake behaviour.
const manualCleanupContext = new AsyncLocalStorage();
const canonicalRepository = path => typeof path === 'string' && path ? realpath(path).catch(() => resolve(path)) : Promise.resolve(null);

function manualCompletionMode(receipt) {
  if (completionReceiptDone(receipt)) return 'ready';
  if (completionWaitingOnRepository(receipt)) return 'repository-held';
  return null;
}

// These are the execution-side prerequisites of isSettleableCompletionReceipt.
// Repository verification produces the remaining cleanup and integration
// receipts, so they cannot be required until after the recheck has run.
function manualCleanupProvenanceValid(agent) {
  const result = agent?.result;
  const metadata = agent?.metadata;
  return result?.deliveryRecoveryOwned === true && result.executionSuccess === true
    && result.validationPassed !== false && result.taskOutcome?.status === 'incomplete'
    && result.taskOutcome?.recovery?.mode === 'cleanup' && !result.executionInterruption
    && !metadata?.executionInterruption && !metadata?.blocker;
}

function manualSwarmContinuationPending(agent) {
  const proof = agent?.metadata?.swarmCleanupDelivery;
  return !!proof && proof.continuationIssued !== true;
}

async function notifyDeliveredSwarmCleanup(agentId, { notify = true } = {}) {
  const [{ getAgentRecord }, contract] = await Promise.all([
    import('../cos/cosAgentLifecycle.js'), import('../swarmCleanupDelivery.js'),
  ]);
  let agent = await getAgentRecord(agentId);
  const task = agent && await getTaskById(agent.taskId);
  const instance = await getInstanceId();
  if (!contract.cleanupRefillSourceMatches(task, agent, instance)) {
    const proof = await contract.proveSwarmCleanupDelivery(task, agent, instance);
    if (!proof) return;
    const { recordSwarmCleanupDelivery } = await import('../cos/cosAgentLifecycle.js');
    if (!await recordSwarmCleanupDelivery(agentId, agent, proof)) return;
    agent = await getAgentRecord(agentId);
  }
  if (notify && contract.cleanupRefillSourceMatches(task, agent, instance) && !agent.metadata.swarmCleanupDelivery.continuationIssued) {
    cosEvents.emit('swarm:cleanup-delivery-verified', { agentId });
  }
}

/** A removed task is never recreated. Its immutable replay only authorizes
 * verification of already absent, exactly captured checkouts. */
async function readAbsentTaskSnapshot(agent) {
  const { readCompletionData } = await import('./agentCompletionData.js');
  const snapshot = (await readCompletionData(agent, agent.metadata?.completionCleanup?.replay).catch(() => null))?.task;
  if (!snapshot || snapshot.id !== agent.taskId) return null;
  const meta = agent.metadata;
  const branches = meta.isWorktree === true ? [meta.worktreeBranch]
    : [meta.claimBranches, meta.claimReleasedBranches].flatMap(value => Array.isArray(value) ? value : []);
  if (!branches.length || branches.some(branch => typeof branch !== 'string' || !branch)) return null;
  const repository = meta.sourceWorkspace || meta.workspacePath;
  const canonical = await canonicalRepository(repository);
  if (!canonical) return null;
  for (const branch of new Set(branches)) {
    const rawCount = meta.completedCheckouts?.filter(row => row?.branch === branch).length ?? 0;
    if (rawCount !== 1 || findValidCheckoutCaptures(agent, { branch, repoPath: canonical }).length !== 1) return null;
  }
  return snapshot;
}

/** Exhaustion stops provider work, not proof of already completed delivery.
 * Only the original cleanup owner and charged dispatch may settle receipts;
 * human holds, another dispatch and failed execution remain stopped.
 */
function exhaustedCleanupOwner(task, agent) {
  const meta = task.metadata || {};
  const binding = agent.metadata?.completionTaskDispatch;
  const expected = binding?.expected;
  return task.status === 'blocked' && meta.blockedCategory === 'task-recovery-exhausted' && !meta.blocker
    && agent.status === 'completed' && agent.taskId === task.id && binding?.taskId === task.id
    && binding.taskType === (task.taskType || 'user') && Array.isArray(expected)
    && meta.deliveryDecisionAgentId === agent.id && agent.result?.executionSuccess === true
    && agent.result.validationPassed !== false && !agent.metadata?.executionInterruption && !agent.result.executionInterruption
    && ['lastSpawnedAt', 'totalSpawnCount'].every(key => {
      const rows = expected.filter(row => Array.isArray(row) && row[0] === key);
      return rows.length === 1 && rows[0][1] != null && meta[key] != null && String(rows[0][1]) === String(meta[key]);
    });
}

const UNSUPPORTED_CLEANUP_SKIPS = new Set([
  REPO_STATE_SKIPS.DISABLED,
  REPO_STATE_SKIPS.NOT_WORKTREE,
  REPO_STATE_SKIPS.PERSISTENT_WORKTREE,
  REPO_STATE_SKIPS.DISCARDED_WORKTREE,
  'retirement-app-unavailable',
  'retirement-app-ambiguous',
]);

const TERMINAL_VERIFICATION_SKIPS = new Set([
  REPO_STATE_SKIPS.DISABLED,
  REPO_STATE_SKIPS.NOT_WORKTREE,
  REPO_STATE_SKIPS.PERSISTENT_WORKTREE,
  REPO_STATE_SKIPS.DISCARDED_WORKTREE,
  REPO_STATE_SKIPS.FAILED_RUN,
]);

async function runManualRecheck(state, options) {
  if (!state.manualCleanupOnly) return null;
  return state.recheckCleanup(options).then(() => null, error => error.message);
}

async function resolveVerificationState(input, cleanupPending) {
  const preCaptureReason = await runManualRecheck(input, { requireCapture: false });
  if (preCaptureReason) return { state: input, skipResult: skipped(preCaptureReason) };
  // A capture that can never complete because its checkout is already gone
  // falls through to the absent-checkout path, which proves delivery from the
  // forge without a captured head.
  let state = input;
  if (state.agentState?.metadata?.checkoutCapture?.status === 'pending' && !(cleanupPending && await pendingCheckoutAbsent(state.agentState))) {
    const { retryCompletionCheckoutCapture, getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
    if (!await retryCompletionCheckoutCapture(state.agentId).catch(() => false)) {
      return { state, skipResult: skipped(REPOSITORY_HOLD.CAPTURE) };
    }
    const recovered = await getAgentRecord(state.agentId).catch(() => null);
    if (!recovered || recovered.status !== 'completed' || recovered.startedAt !== state.agentState.startedAt
      || recovered.metadata?.checkoutCapture?.status !== 'captured') {
      return { state, skipResult: skipped(REPOSITORY_HOLD.CAPTURE) };
    }
    state = { ...state, agentState: recovered };
  }
  const postCaptureReason = await runManualRecheck(state);
  if (postCaptureReason) return { state, skipResult: skipped(postCaptureReason) };
  if (cleanupPending) {
    const original = await getTaskById(state.task.id);
    if (!original) {
      if (state.manualCleanupOnly) return { state, skipResult: skipped('cleanup-owner-changed') };
      const snapshot = await readAbsentTaskSnapshot(state.agentState);
      if (!snapshot) return { state, skipResult: skipped('cleanup-task-unavailable') };
      const absentState = { ...state, task: snapshot, originTaskAbsent: true };
      return { state: absentState, branchInput: { ...absentState, success: true, cleanupWarnings: [] } };
    }
    const current = state.manualCleanupOnly ? original : await recoverCompletionTaskHandoff(state.agentState) || original;
    if ((state.manualCleanupOnly && !isDeepStrictEqual(current, state.task))
      || (current.status !== 'in_progress' && !exhaustedCleanupOwner(current, state.agentState))
      || current.metadata?.deliveryRecovery !== 'cleanup'
      || current.metadata.deliveryRecoveryAgentId !== state.agentId) {
      return { state, skipResult: skipped('cleanup-owner-changed') };
    }
    state = { ...state, task: current };
  }
  // A cleanup warning describes retained work this audit must settle.
  return {
    state,
    branchInput: { ...state, success: state.success || cleanupPending, ...(cleanupPending ? { cleanupWarnings: [] } : {}) },
  };
}

async function settleOwnershipOrAbsentTask(state, result) {
  if (result.skipReason === 'cleanup-owner-changed' && !state.manualCleanupOnly) {
    // Delivery now belongs to the task's current owner; this run keeps only its own checkout.
    const scope = handedOffRetirementScope(state.agentState);
    return scope && await settleAbsentScope(state.agentState, scope)
      ? { ...result, physicalRetirementVerified: true, skipReason: 'original-result-preserved' } : result;
  }
  if (result.skipReason === 'cleanup-owner-changed' || result.skipReason === 'cleanup-task-unavailable') return result;
  if (state.originTaskAbsent) {
    if (!result.verified) return result;
    const { settleAbsentTaskCompletion } = await import('../cos/cosAgentLifecycle.js');
    const settled = await settleAbsentTaskCompletion(state.agentId, state.agentState);
    return settled ? result : { ...result, verified: false, skipReason: 'cleanup-receipt-settlement-unverified' };
  }
  return null;
}

const isReadableMissingPrCleanupSkip = item => item.skipReason === 'cleanup-delivery-unverified'
  && item.observed?.prState === null && item.observed?.prUrl === null && item.observed?.unreadable?.length === 0;

async function findUnsupportedCleanupOutcome(state, result, { swarmCleanup }) {
  const outcomes = result.branches || [result];
  // A retirement policy refusal is a preservation hold, not failed delivery.
  // Keep its persisted obligation pending for service replay; requeueing the
  // original task would launch another review agent against an already merged PR.
  const unsupportedOutcomes = prStaysOpen(state.task)
    ? [{ skipReason: 'leave-open-cleanup-unsupported' }]
    : outcomes.filter(item => UNSUPPORTED_CLEANUP_SKIPS.has(item.skipReason)
      || (item.skipReason === 'cleanup-delivery-unverified' && (['OPEN', 'CLOSED'].includes(item.observed?.prState)
        || isReadableMissingPrCleanupSkip(item))));
  const unsupported = unsupportedOutcomes[0] || null;
  if (!swarmCleanup || !unsupported || !unsupportedOutcomes.every(isReadableMissingPrCleanupSkip)) return unsupported;
  // A parked child has no PR by design. Verify every selected issue and
  // the parked checkout independently before retaining this as a service
  // hold; this evidence neither retires the checkout nor completes the task.
  const { verifyCleanupClaimDisposition } = await import('../claimDisposition.js');
  const disposition = await verifyCleanupClaimDisposition({ task: state.task, agent: state.agentState }).catch(() => null);
  const allOperatorBlocked = disposition?.status === 'verified' && unsupportedOutcomes.every(item => {
    const issue = item.branch?.match(/^claim\/issue-([1-9]\d*)$/)?.[1];
    return issue && disposition.issues?.some(row => row.issue === Number(issue) && row.disposition === 'operator-blocked');
  });
  return allOperatorBlocked ? null : unsupported;
}

async function transferUnsupportedCleanupToRecovery(state, result, unsupported) {
  // An exhausted task gets no new recovery dispatch or refunded budget.
  if (state.task.status === 'blocked') return result;
  const { resolveUndeliveredTaskUpdate } = await import('./agentErrorAnalysis.js');
  const outcome = { status: 'incomplete', reason: `Cleanup verification cannot run (${unsupported.skipReason}). ${state.task.metadata?.taskOutcome?.reason || ''}`.trim() };
  const planned = resolveUndeliveredTaskUpdate(state.task, outcome, state.agentId);
  const saved = await updateTask(state.task.id, planned, state.task.taskType || 'user', {
    expectedStatus: 'in_progress',
    expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: state.agentId },
  });
  if (saved?.status !== planned.status || saved?.error || saved?.statusChanged) {
    return { ...result, skipReason: 'cleanup-transfer-unverified' };
  }
  if (planned.metadata.retryPendingCleanup) {
    const { releaseRetryHold } = await import('./agentWorktreeCleanup.js');
    await releaseRetryHold({ agentId: state.agentId, task: state.task, success: false, agentMetadata: state.agentState.metadata });
  }
  const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
  await recordRepoStateVerification(state.agentId, { status: 'completed', reasons: ['cleanup-transferred-to-recovery'] });
  return { ...result, skipReason: 'cleanup-transferred-to-recovery' };
}

async function settleVerifiedCleanupTask(state, result) {
  const preLedgerReason = await runManualRecheck(state);
  if (preLedgerReason) return { ...result, verified: false, skipReason: preLedgerReason };
  const { recordCompletionCleanup } = await import('../cos/cosAgentLifecycle.js');
  if (state.agentState.metadata?.completionCleanup?.version === COMPLETION_RECEIPT_VERSION) {
    // A deferred receipt releases held chain stages to the normal replay,
    // whose later verification pass settles the task after they finish.
    const recorded = await recordCompletionCleanup(state.agentId, state.agentState.startedAt, {
      stages: { [COMPLETION_STAGE.WORKTREE]: verifiedRepositoryWorktreeStage(state.deferTaskSettlement) },
    });
    if (!recorded) return { ...result, verified: false, skipReason: 'cleanup-ledger-settlement-unverified' };
  }
  const preTaskReason = await runManualRecheck(state);
  if (preTaskReason) return { ...result, verified: false, skipReason: preTaskReason };
  if (state.deferTaskSettlement) {
    const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
    await recordRepoStateVerification(state.agentId, {
      status: 'pending', checkedAt: new Date().toISOString(), reasons: ['completion-handoff-pending'],
    });
    return { ...result, verified: false, skipReason: 'completion-handoff-pending' };
  }
  const settlementFence = state.task.status === 'blocked' ? {
    expectedStatus: 'blocked', expectedTask: { description: state.task.description, priority: state.task.priority, metadata: state.task.metadata },
    recoveryOwner: { id: state.agentId, startedAt: state.agentState.startedAt }, preserveRetryBudget: true,
  } : {
    expectedStatus: 'in_progress', expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: state.agentId },
    // getTaskById projects the queue source into taskType; the stored row
    // may have a different or absent value, so fence its remaining fields.
    ...(state.manualCleanupOnly && {
      suppressCompletionWake: true,
      recoveryOwner: { id: state.agentId, startedAt: state.agentState.startedAt, requireInactive: true },
      expectedTask: Object.fromEntries(Object.entries(state.task).filter(([key]) => key !== 'taskType')),
    }),
  };
  const updated = await updateTask(state.task.id, { status: 'completed', metadata: {
    deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined,
    taskOutcome: { status: 'completed', reason: 'Delivery and repository cleanup were verified by completion recovery.' },
  } }, state.task.taskType || 'user', settlementFence);
  if (updated?.status !== 'completed' || updated?.error || updated?.statusChanged) {
    return { ...result, verified: false, skipReason: 'cleanup-task-settlement-unverified' };
  }
  return null;
}

async function recordPendingRepoStateStatus(state, result, { cleanupPending }) {
  // Completion persists pending before publishing its event. A failed probe,
  // active follow-up or refused task write stays pending for the timer sweep.
  if (state.agentState?.metadata?.repoStateVerification?.status !== 'pending') return;
  const outcomes = result.branches || [result];
  const settled = cleanupPending ? result.verified
    : outcomes.every(item => item.verified || (TERMINAL_VERIFICATION_SKIPS.has(item.skipReason)
      && !(item.skipReason === REPO_STATE_SKIPS.FAILED_RUN && state.agentState?.metadata?.cleanupOutcome?.status === 'pending')))
      || leavesPrForHuman(state.task);
  const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
  await recordRepoStateVerification(state.agentId, {
    status: settled ? 'completed' : 'pending',
    checkedAt: new Date().toISOString(),
    reasons: [...new Set(outcomes.map(item => item.skipReason).filter(Boolean))],
  });
}

/**
 * Verify one completed worktree agent left the repository as its task asked, and
 * file a recovery task when it did not.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {object} input.task - the CoS task
 * @param {object|null} input.agentState - persisted agent record (worktree metadata)
 * @param {boolean} input.success - effective success of the run
 * @param {boolean} [input.prExpected] - legacy override for the live task's `openPR` hint
 * @param {'force-branch' | 'sweep-review-target'} [input.prProbeFallback] - internal branch lookup adapter
 * @param {string[]} [input.cleanupWarnings] - warnings cleanup already raised
 * @returns {Promise<{verified: boolean, skipReason: string|null, issues: Array<{code: string, message: string}>, observed: object|null, recoveryTaskId: string|null}>}
 */
export async function verifyAgentRepoState(input) {
  if (verificationRuns.has(input.agentId)) return verificationRuns.get(input.agentId);
  const cleanupPending = input.agentState?.result?.cleanupPending === true;
  const swarmCleanup = cleanupPending && input.agentState?.metadata?.configClaimFlow === true
    && input.agentState.metadata.isWorktree === false;
  const run = withDeliveryActivity(input.agentId, 'Checking delivery and repository preservation', async () => {
    if (swarmCleanup && !input.manualCleanupOnly) {
      // Persist delivery proof before cleanup can settle the task, but let the
      // first retirement pass finish before a new picker enters the repository.
      await notifyDeliveredSwarmCleanup(input.agentId, { notify: false }).catch(error => {
        emitLog('warn', `Swarm delivery verification deferred: ${error.message}`, { agentId: input.agentId });
      });
    }
    const resolved = await resolveVerificationState(input, cleanupPending);
    const { state } = resolved;
    const result = resolved.skipResult || await verifyRunBranches(resolved.branchInput);
    const earlyOwnership = await settleOwnershipOrAbsentTask(state, result);
    if (earlyOwnership) return earlyOwnership;
    const unsupported = await findUnsupportedCleanupOutcome(state, result, { swarmCleanup });
    if (cleanupPending && unsupported && !state.manualCleanupOnly) {
      return transferUnsupportedCleanupToRecovery(state, result, unsupported);
    }
    if (cleanupPending && result.verified) {
      const heldSettlement = await settleVerifiedCleanupTask(state, result);
      if (heldSettlement) return heldSettlement;
    }
    await recordPendingRepoStateStatus(state, result, { cleanupPending });
    if (swarmCleanup && !state.manualCleanupOnly) {
      await notifyDeliveredSwarmCleanup(state.agentId).catch(error => {
        emitLog('warn', `Swarm delivery verification deferred: ${error.message}`, { agentId: state.agentId });
      });
    }
    return result;
  }).finally(() => verificationRuns.delete(input.agentId));
  verificationRuns.set(input.agentId, run);
  return run;
}

/** Recheck one current cleanup owner without starting another provider task. */
export async function recheckAgentCleanup(agentId, taskId) {
  const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
  const agent = await getAgentRecord(agentId);
  const task = await getTaskById(taskId);
  if (!agent || !task || agent.taskId !== taskId || agent.status !== 'completed'
    || agent.result?.cleanupPending !== true || task.status !== 'in_progress'
    || task.metadata?.deliveryRecovery !== 'cleanup' || task.metadata.deliveryRecoveryAgentId !== agentId) {
    return { ok: false, reason: 'cleanup-owner-changed' };
  }
  if (verificationRuns.has(agentId) || getDeliveryActivity(agentId)) return { ok: false, reason: 'cleanup-already-running' };
  if (!manualCleanupProvenanceValid(agent)) return { ok: true, verified: false, reasons: ['cleanup-provenance-unverified'] };
  if (manualSwarmContinuationPending(agent)) return { ok: true, verified: false, reasons: ['swarm-continuation-pending'] };
  const mode = manualCompletionMode(agent.metadata?.completionCleanup);
  if (!mode) return { ok: true, verified: false, reasons: ['completion-stages-pending'] };
  const recheckCleanup = async ({ requireCapture = true } = {}) => {
    const [currentTask, currentAgent] = await Promise.all([getTaskById(taskId), getAgentRecord(agentId)]);
    if (!isDeepStrictEqual(currentTask, task) || currentAgent?.status !== 'completed' || currentAgent.result?.cleanupPending !== true
      || currentAgent.taskId !== taskId || currentAgent.startedAt !== agent.startedAt) throw new Error('cleanup-owner-changed');
    if (!manualCleanupProvenanceValid(currentAgent)) throw new Error('cleanup-provenance-unverified');
    if (manualSwarmContinuationPending(currentAgent)) throw new Error('swarm-continuation-pending');
    // A held run never settles here, even if its stages finish concurrently.
    const current = manualCompletionMode(currentAgent.metadata?.completionCleanup);
    if (!current || (mode === 'ready' && current !== 'ready')) throw new Error('completion-stages-pending');
    if (requireCapture && currentAgent.metadata?.checkoutCapture?.status !== 'captured') throw new Error('checkout-capture-unverified');
  };
  const result = await manualCleanupContext.run(true, () => verifyAgentRepoState({ agentId, agentState: agent, task, success: agent.result.success === true,
    manualCleanupOnly: true, recheckCleanup,
    deferTaskSettlement: mode === 'repository-held' }));
  if (result.skipReason === 'cleanup-owner-changed') return { ok: false, reason: result.skipReason };
  const reasons = [...new Set([result.skipReason, ...(result.branches || []).map(row => row.skipReason)].filter(Boolean))];
  return { ok: true, verified: result.verified === true, reasons };
}

/** Physical cleanup uses the registered checkout scope, including legacy records
 * that predate the current snapshot fields. */
function recordedCheckoutScope(agent) {
  const meta = agent?.metadata;
  if (![meta?.sourceWorkspace, meta?.workspacePath, meta?.worktreeBranch].every(value => typeof value === 'string' && value)
    || resolve(meta.sourceWorkspace) === resolve(meta.workspacePath)) return null;
  return { repoPath: meta.sourceWorkspace, path: meta.workspacePath, branch: meta.worktreeBranch };
}

function pendingCheckoutScope(agent) {
  return agent.status === 'completed' && agent.metadata?.checkoutCapture?.status === 'pending'
    && agent.metadata.checkoutCapture.unknown === true && agent.metadata.completionCleanup?.status === 'pending'
    ? recordedCheckoutScope(agent) : null;
}

async function pendingCheckoutAbsent(agent) {
  const scope = pendingCheckoutScope(agent);
  if (!scope) return false;
  const worktrees = await listWorktrees(scope.repoPath).catch(() => null);
  return !!worktrees && await readCheckoutPathPresence(scope.path) === false
    && await readLocalBranchPresence(scope.repoPath, scope.branch) === false
    && !worktrees.some(row => resolve(row.path) === resolve(scope.path) || shortBranch(row.branch) === scope.branch);
}

/** A cleanup run whose task moved to another owner owes only its own checkout's
 * physical cleanup; the current owner verifies delivery. The writer settles it
 * only once that move is final. */
function handedOffRetirementScope(agent) {
  const meta = agent?.metadata;
  if (agent?.status !== 'completed' || agent.result?.cleanupPending !== true || meta?.isWorktree !== true
    || meta.checkoutCapture?.status !== 'captured' || meta.completionCleanup?.status !== 'pending'
    || ![meta.sourceWorkspace, meta.workspacePath, meta.worktreeBranch].every(value => typeof value === 'string' && value)) return null;
  const captured = (meta.completedCheckouts || []).filter(row => row?.branch === meta.worktreeBranch
    && typeof row.path === 'string' && row.path).map(row => row.path);
  return { repoPath: meta.sourceWorkspace, branch: meta.worktreeBranch, paths: [...new Set([meta.workspacePath, ...captured])] };
}

/** Settle physical cleanup once every checkout path, the local branch and any
 * worktree entry are gone and no live run owns the branch. The execution result
 * is never changed. */
async function settleAbsentScope(agent, { repoPath, branch, paths }, proof = {}) {
  return withClaimOwnershipLock(async () => {
    const { recordAbsentCheckoutRetirement } = await import('../cos/cosAgentLifecycle.js');
    const owners = await readClaimOwnershipAgents().catch(() => null);
    if (!owners || owners.some(owner => ['running', 'paused'].includes(owner.status)
      && resolve(owner.metadata?.sourceWorkspace || owner.metadata?.workspacePath || '') === resolve(repoPath)
      && (resolveTaskTargetBranch(owner.metadata) === branch || owner.metadata?.worktreeBranch === branch
        || owner.metadata?.claimBranches?.includes(branch)))) return false;
    const worktrees = await listWorktrees(repoPath).catch(() => null);
    if (!worktrees) return false;
    for (const path of paths) if (await readCheckoutPathPresence(path) !== false) return false;
    if (await readLocalBranchPresence(repoPath, branch) !== false
      || worktrees.some(row => paths.includes(row.path) || shortBranch(row.branch) === branch)) return false;
    return recordAbsentCheckoutRetirement(agent.id, agent, { path: paths[0], branch, ...proof });
  });
}

// Repair only the obsolete path-specific hold behind an already verified
// released selection. This does not reopen tasks, retry delivery or remove data.
async function settleReleasedSelectionHistory(agentId, metadata, branch, trees) {
  const held = Object.values(metadata.cleanupOutcomes || {}).filter(row => row.branch === branch && row.status !== 'verified' && row.path != null);
  for (const row of held) {
    if (row.reason !== 'absent-checkout-integration-unverified' || typeof row.path !== 'string'
      || trees.some(tree => resolve(tree.path) === resolve(row.path))
      || await readCheckoutPathPresence(row.path).catch(() => null) !== false) return false;
  }
  for (const row of held) await branchLedger(agentId, { branch, path: row.path })
    .record('verified', 'released-selection-no-local-artifacts');
  return true;
}

const skipped = (skipReason, { issues = [], observed = null } = {}) => ({ verified: false, skipReason, issues, observed, recoveryTaskId: null });

const {
  resumeAgentCompletionRetirement,
  bindCompletionRetirementEvents,
  sweepRepoStateVerifications,
  resumeDeferredRepoStateVerifications,
} = createRepoStateSweep({
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
});

export {
  resumeAgentCompletionRetirement,
  bindCompletionRetirementEvents,
  sweepRepoStateVerifications,
  resumeDeferredRepoStateVerifications,
};

/**
 * The cleanup ledger for one branch. `blockWith` records a hold and returns the
 * matching skip in one step, so a gate cannot return a skip while leaving the
 * ledger silent about the branch it held. `skipReason` overrides the returned
 * reason only where the caller-facing skip code differs from the ledger reason.
 *
 * @param {string} agentId
 * @param {{branch: string, path?: string}} location - stamped on every ledger entry
 */
function branchLedger(agentId, location, recordCleanup) {
  const record = async (status, reason, extra = {}) => {
    if (recordCleanup) return recordCleanup({ status, reason, ...location, ...extra });
    const { recordCleanupOutcome } = await import('../cos/cosAgentLifecycle.js');
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
  const repository = await canonicalRepository(sourceWorkspace);
  const holdBranch = async (branch, reason, extra, path) => {
    // Per-branch swarm results carry no observation; a held branch was never probed.
    const { observed: _unprobed, ...held } = await branchLedger(input.agentId, { branch, ...(path && { path }) }, input.recordCleanup).blockWith(reason, { record: extra });
    return { branch, ...held };
  };
  const results = [];
  for (const branch of branches) {
    if (input.recheckCleanup) {
      const reason = await input.recheckCleanup().then(() => null, error => error.message);
      if (reason) { results.push(await holdBranch(branch, reason)); continue; }
    }
    const captures = findValidCheckoutCaptures(input.agentState, { branch, repoPath: repository });
    const original = meta.completedCheckouts?.find(row => row.branch === branch);
    // A transient forge failure for one sibling must not undo an already
    // verified removal of this run's exact captured checkout. A reused path or
    // branch still goes through the normal checkout and ownership checks.
    const capture = captures.length === 1 ? captures[0] : null;
    const previous = capture && meta.cleanupOutcomes?.[JSON.stringify([branch, capture.path])];
    if (previous?.status === 'verified'
      && !trees.some(tree => shortBranch(tree.branch) === branch || canonicalizePath(tree.path) === canonicalizePath(capture.path))
      && await readCheckoutPathPresence(capture.path).catch(() => null) === false
      && await readLocalBranchPresence(sourceWorkspace, branch).catch(() => null) === false) {
      results.push({ branch, verified: true, issues: [], skipReason: null });
      continue;
    }
    const agents = await readClaimOwnershipAgents().catch(() => null);
    const owner = claimCheckoutOwner({ branchName: branch, sourceWorkspace, agents, ignoreIds: [input.agentId] });
    if (owner) {
      results.push(await holdBranch(branch, owner.reason, { owners: owner.owners }, captures.length === 1 ? captures[0].path : null));
      continue;
    }
    // A current branch holder is not evidence of the old claim's checkout.
    // The server's completion capture names the original checkout scope.
    // With no checkout and no local ref left, only delivery proof remains:
    // only the delivery evidence remains to settle.
    const absent = !original?.path && !trees.some(tree => shortBranch(tree.branch) === branch)
      && await readLocalBranchPresence(sourceWorkspace, branch).catch(() => null) === false;
    // A selection explicitly handed back before another claim was captured
    // owns no delivery obligation when no local artifact ever remains. Keep
    // captured checkouts and current bindings on the full proof path;
    // release alone must not erase evidence of actual work.
    const releasedSelection = absent && (meta.claimReleasedBranches?.includes(branch) || (meta.claimBranches?.length > 1 && !original?.path))
      && (!meta.claimBranches?.includes(branch) || !meta.claimReleasedBranches?.includes(branch)) && meta.checkoutCapture?.status === 'captured'
      && findValidCheckoutCaptures(input.agentState, { excludeBranch: branch, repoPath: repository }).length > 0;
    if (releasedSelection && await settleReleasedSelectionHistory(input.agentId, meta, branch, trees)) {
      await branchLedger(input.agentId, { branch }).record('verified', 'released-selection-no-local-artifacts');
      results.push({ branch, verified: true, issues: [], skipReason: null });
      continue;
    }
    if (!original?.path && !absent) {
      results.push(await holdBranch(branch, 'claim-checkout-identity-unverified'));
      continue;
    }
    results.push({ branch, ...await verifyAgentBranchState({ ...input, prProbeFallback: 'force-branch',
      agentState: { ...input.agentState, metadata: { ...meta, isWorktree: true,
        worktreeBranch: branch, sourceWorkspace, workspacePath: original?.path ?? null } },
    }) });
  }
  return { verified: results.every(result => result.verified), branches: results,
    issues: results.flatMap(result => result.issues), skipReason: null };
}

function resolvePrProbeIntent({ task, metadata, staysOpen, originalPrUrl, originTaskAbsent, prExpected, prProbeFallback }) {
  if (staysOpen) return { kind: 'skip' };
  if (originalPrUrl) return { kind: 'exact-target', url: originalPrUrl };

  const taskRequestsPr = isTruthyMeta(task?.metadata?.openPR);
  // The saved task can restore a PR request the caller did not carry through.
  const requested = originTaskAbsent ? prExpected || taskRequestsPr : prExpected ?? taskRequestsPr;
  // Claim prompts own publication even when the generic openPR toggle is off.
  const claimOwnsPublication = hasClaimFlowContract(task) || isTruthyMeta(metadata.configClaimFlow);
  // The sweep uses even an unparseable review target as a hint to look up the branch.
  const sweepReviewHint = prProbeFallback === 'sweep-review-target'
    && (task?.metadata?.reviewLoopPRUrl || metadata.reviewLoopMergeTarget?.url);
  if (requested || claimOwnsPublication || sweepReviewHint || prProbeFallback === 'force-branch') return { kind: 'branch' };
  return { kind: 'skip' };
}

async function verifyAgentBranchState({ agentId, task, agentState, success, prExpected, prProbeFallback, cleanupWarnings = [], originTaskAbsent = false, recheckCleanup, recordCleanup, manualCleanupOnly = false }) {
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
    ? await (await import('../apps.js')).getAppById(appId).catch(() => UNREADABLE)
    : null;
  if (app === UNREADABLE) return skipped(REPO_STATE_SKIPS.GATE_UNREADABLE);

  const worktreePath = isTruthyMeta(metadata.claimPicksOwnBranch) ? metadata.workspacePath : metadata.workspacePath || join(PATHS.worktrees, agentId);
  const { record, blockWith } = branchLedger(agentId, { branch: branchName, path: worktreePath }, recordCleanup);
  const enabled = repoStateVerificationEnabled(app);
  const owned = enabled ? await branchHasPendingOwner(branchName, sourceWorkspace, app, agentState?.result?.cleanupPending === true ? { taskId: task.id, agentId } : null).catch(() => null) : false;
  if (owned === null) return blockWith('ownership-unreadable', { skipReason: REPO_STATE_SKIPS.GATE_UNREADABLE });
  if (owned) await record('pending', 'existing-completion-owner');

  // Completion can hand delivery to a server-created review task before the
  // parent records a PR URL. Reuse that exact target after its head changes.
  const followUp = task?.metadata?.deliveryFollowUpTaskId
    ? await getTaskById(task.metadata.deliveryFollowUpTaskId) : null;
  const followUpPrUrl = isTruthyMeta(followUp?.metadata?.reviewLoopFollowUp)
    && followUp.metadata.sourceTaskId === task.id && followUp.metadata.sourceAgentId === agentId
    && followUp.metadata.reviewLoopPRBranch === branchName && followUp.metadata.app === task.metadata?.app
    ? followUp.metadata.reviewLoopPRUrl : null;
  const originalPrUrl = [metadata.reviewLoopMergeTarget?.url, metadata.recoveryMergeTarget?.url,
    task?.metadata?.reviewLoopPRUrl, task?.metadata?.recoveryMergeTarget?.url, followUpPrUrl].find(value => parsePullRequestUrl(value));
  const expectation = resolveRepoStateExpectation({ ...structural, enabled, followUpPending: owned });
  if (!expectation.verify) return skipped(expectation.skipReason);

  const hold = await resolveCheckoutHold({ agentId, metadata, sourceWorkspace, branchName, worktreePath });
  if (hold) return blockWith(hold.reason, { record: hold.record });
  const prProbe = resolvePrProbeIntent({ task, metadata, staysOpen: expectation.staysOpen, originalPrUrl, originTaskAbsent, prExpected, prProbeFallback });
  const observed = await probeRepoState({
    sourceWorkspace,
    branchName,
    worktreePath,
    branchShouldBeGone: !expectation.staysOpen,
    prProbe,
  }).catch(err => {
    emitLog('warn', `🔎 Repo-state probe failed for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  if (!observed) return blockWith('probe-incomplete', { skipReason: REPO_STATE_SKIPS.PROBE_INCOMPLETE });

  if (observed.worktreePresent === false && observed.localBranchPresent === false) {
    return settleAbsentCheckout({ agentId, agentState, metadata, app, sourceWorkspace, branchName, worktreePath, originalPrUrl, observed, record, staysOpen: expectation.staysOpen, recheckCleanup });
  }
  if (originTaskAbsent) return skipped('removed-task-checkout-still-present');
  const issues = classifyRepoStateIssues({ ...expectation, prExpected: prProbe.kind !== 'skip' }, { ...observed, branchName });
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
    if (manualCleanupOnly) return blockWith('leave-open-cleanup-unsupported', { issues, observed });
    return skipped(null, { issues, observed });
  }

  return settleDivergedBranch({ agentId, task, agentState, app, appId, metadata, sourceWorkspace, branchName, worktreePath,
    observed, issues, record, blockWith, recheckCleanup, manualCleanupOnly });
}

/**
 * A reused branch is not the old checkout. No model is needed to identify a
 * different holder, and its live work must never become this parent's target.
 *
 * @returns {Promise<{reason: string, record?: object}|null>} the hold, or null when this run still owns the checkout
 */
async function resolveCheckoutHold({ agentId, metadata, sourceWorkspace, branchName, worktreePath }) {
  const inventory = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!inventory) return { reason: 'checkout-inventory-unavailable' };
  const holders = inventory.filter(tree => shortBranch(tree.branch) === branchName);
  // Git porcelain uses forward slashes on Windows; registration spelling is
  // not a checkout change. Compare native lexical paths and the recorded head.
  const samePath = tree => !!worktreePath && canonicalizePath(tree.path) === canonicalizePath(worktreePath);
  const pathHolder = inventory.find(samePath);
  if (holders.some(tree => !samePath(tree))
    || (pathHolder && shortBranch(pathHolder.branch) !== branchName)) {
    return { reason: 'checkout-changed' };
  }
  const completed = metadata.completedCheckouts?.find(row => row.branch === branchName && resolve(row.path) === resolve(worktreePath));
  if (completed && pathHolder) {
    const identity = await readCompletedCheckoutIdentity({ repoPath: sourceWorkspace, branch: branchName,
      path: worktreePath, head: pathHolder.head }).catch(() => null);
    if (!identity || identity.head !== completed.head) {
      return { reason: 'checkout-changed' };
    }
  }
  const owner = claimCheckoutOwner({ branchName, sourceWorkspace,
    agents: await readClaimOwnershipAgents().catch(() => null),
    ignoreIds: agentId ? [agentId] : [] });
  return owner ? { reason: owner.reason, record: { owners: owner.owners } } : null;
}

async function containedInDefaultBranch(sourceWorkspace, head) {
  const branch = await getDefaultBranch(sourceWorkspace, { allowRemote: false, strict: true }).catch(() => null);
  if (!branch) return false;
  const result = await execGit(['merge-base', '--is-ancestor', head, `refs/remotes/origin/${branch}`], sourceWorkspace,
    { ignoreExitCode: true, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } }).catch(() => null);
  return result?.exitCode === 0;
}

/** Already removed checkouts need delivery proof, not a retroactive backup. */
async function settleAbsentCheckout({ agentId, agentState, metadata, app, sourceWorkspace, branchName, worktreePath, originalPrUrl, observed, record, staysOpen, recheckCleanup }) {
  const { readMergedPrDelivery } = await import('../mergedPrEvidence.js');
  const repository = await canonicalRepository(sourceWorkspace);
  // Opening a PR need not have been requested by the original task. A run
  // can nevertheless have delivered one itself. Its immutable capture permits
  // a read-only merge lookup; it never authorizes removal or a made-up receipt.
  const captures = agentState?.status === 'completed'
    ? findValidCheckoutCaptures(agentState, { branch: branchName, repoPath: repository, path: worktreePath })
    : [];
  const capturedHead = captures.length === 1 ? captures[0].head : null;
  const delivery = capturedHead && !originalPrUrl && !observed.prState
    ? await probePrForBranch(sourceWorkspace, branchName).catch(() => null) : observed;
  const proofUrl = originalPrUrl || delivery?.prUrl;
  let forgeRefusal = null;
  const forge = proofUrl && delivery?.prState === 'MERGED' ? await readMergedPrDelivery(sourceWorkspace, branchName, proofUrl,
    { forgeAccount: app?.forgeAccount ?? null, ...(capturedHead && { exactDeliveredHead: capturedHead }) })
    .catch(err => { forgeRefusal = err?.message; return null; }) : null;
  // The forge binds merged delivery to this repository and named PR branch.
  // A follow-up may rebase or advance its head after the original capture.
  // With the checkout and local ref already absent, there is nothing to remove
  // or preserve; a historical retirement receipt cannot add delivery evidence.
  // An inferred branch lookup has no original PR identity. In that case only
  // exact/ancestor delivery links its capture to the PR we found.
  const integrated = !!forge && (!!originalPrUrl || !capturedHead || forge.prHead === capturedHead
    || (forge.scopeProof === 'ancestor-of-delivered-head' && forge.deliveredAncestorHead === capturedHead));
  // A run that never published (a no-change audit) has no PR to prove. When the
  // forge affirmatively reports none, no remote branch holds other work, and the
  // captured final head is already in the fetched default branch, the removed
  // checkout held nothing undelivered.
  // A merged contributor-fork PR is refused by the same-repository helper
  // ('merged-pr-not-matching'); the forge still reports it MERGED, so the
  // captured head's ancestry in the fetched default branch proves delivery.
  const noPrToProve = !proofUrl && delivery?.readable === true && !delivery.prState;
  // Only the task's own recorded PR identity qualifies: a PR inferred from a
  // branch-name probe could be unrelated, so ancestry alone must not settle it.
  const mergedForkPr = !!originalPrUrl && delivery?.prState === 'MERGED' && forgeRefusal === 'merged-pr-not-matching';
  const unpublishedContained = !integrated && capturedHead && (noPrToProve || mergedForkPr)
    && observed.remoteBranchPresent === false && await containedInDefaultBranch(sourceWorkspace, capturedHead);
  if (!staysOpen && integrated && observed.remoteBranchPresent !== false) {
    const reason = observed.remoteBranchPresent === true ? 'remote-branch-present' : 'remote-branch-unverified';
    await record('blocked', reason, { prUrl: proofUrl, committedIntegrationVerified: true });
    return skipped(reason);
  }
  if (!staysOpen && (integrated || unpublishedContained)) {
    const verified = await withClaimOwnershipLock(async () => {
      await recheckCleanup?.();
      if (await resolveCheckoutHold({ agentId, metadata, sourceWorkspace, branchName, worktreePath })
        || (worktreePath && await readCheckoutPathPresence(worktreePath) !== false)
        || await readLocalBranchPresence(sourceWorkspace, branchName) !== false) return false;
      return await (integrated
        ? record('verified', 'already-absent-merged', { prUrl: proofUrl, committedIntegrationVerified: true })
        : record('verified', 'already-absent-integrated', { committedIntegrationVerified: true })) === true;
    }).catch(() => false);
    if (verified) return { verified: true, skipReason: null, issues: [], observed, recoveryTaskId: null };
    const reason = 'absent-checkout-settlement-unverified';
    await record('blocked', reason, { prUrl: proofUrl, committedIntegrationVerified: true });
    return skipped(reason);
  }
  const reason = 'absent-checkout-integration-unverified';
  await record('blocked', reason, { prUrl: proofUrl, committedIntegrationVerified: !!integrated });
  return skipped(reason);
}

/**
 * The branch diverged from its expected end state. A merged checkout goes
 * through the retirement gate; anything else is an undelivered branch.
 */
async function settleDivergedBranch(ctx) {
  const { agentId, appId, app, sourceWorkspace, branchName, worktreePath, observed, issues, blockWith } = ctx;
  if (observed.prState !== 'MERGED' || !(observed.worktreePresent || observed.localBranchPresent)) {
    return settleUndeliveredBranch(ctx);
  }
  const prepared = await prepareRecoveryRetirement({ agentId, appId, app, sourceWorkspace, branchName, worktreePath, observed })
    .catch(() => ({ reason: 'retirement-evidence-unavailable' }));
  if (!prepared.retirement) {
    const held = await blockWith(prepared.reason, { issues, observed });
    // The retirement gate declining is its designed outcome; the reason is recorded on the ledger above.
    emitLog('info', `⏸️ Repo-state retirement retained ${branchName}: ${prepared.reason}`, { agentId, branchName });
    return held;
  }
  if (prepared.integrated) return retireIntegratedCheckout({ ...ctx, appId: prepared.appId }, prepared.retirement);
  if (ctx.manualCleanupOnly) return blockWith('cleanup-review-required', { issues, observed });
  if (ctx.task?.status === 'blocked' && ctx.agentState?.result?.cleanupPending === true) {
    return ctx.blockWith('cleanup-budget-exhausted', { issues, observed });
  }
  // A recovery successor cannot start a new lineage with a fresh budget.
  if (ctx.task?.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup') {
    return ctx.blockWith('cleanup-successor-review-unresolved', { issues: ctx.issues, observed: ctx.observed });
  }
  return fileDivergenceRecovery({ ...ctx, appId: prepared.appId }, prepared.retirement);
}

async function retireIntegratedCheckout({ agentId, appId, observed, issues, record, blockWith, recheckCleanup, manualCleanupOnly, metadata, sourceWorkspace, branchName, worktreePath }, retirement) {
  const { retireInventoriedCheckout, assertAutomaticRetirementAllowed } = await import('../heldCheckoutRecovery.js');
  const result = await retireInventoriedCheckout({ appId, release: retirement.release }, { beforeMutation: async () => {
      // An explicit host-authorized recheck is not unattended daemon work.
      // It still goes through all ownership, merge and content gates.
      if (!manualCleanupOnly) await assertAutomaticRetirementAllowed();
      await recheckCleanup?.();
      if (recheckCleanup) {
        const hold = await resolveCheckoutHold({ agentId, metadata, sourceWorkspace, branchName, worktreePath });
        if (hold) throw new Error(hold.reason);
      }
    } }).catch(error => ({ reason: (['daemon-stopped', 'automatic-retirement-disabled', 'checkout-changed', 'claim-owner-active', 'claim-owner-ambiguous', 'cleanup-owner-changed', 'cleanup-provenance-unverified', 'swarm-continuation-pending', 'completion-stages-pending', 'checkout-capture-unverified'].includes(error.message)) ? error.message : 'retirement-outcome-uncertain' }));
  if (!result.ok || result.branchDeleted !== true) {
    return blockWith(result.reason || result.branchRetainedReason || 'retirement-outcome-uncertain', { issues, observed });
  }
  await record('verified', 'retirement-receipt-verified', { prUrl: observed.prUrl, committedIntegrationVerified: true,
    preservation: { verifiedAt: new Date().toISOString() } });
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
    const { inspectOrQueueCompletedReview } = await import('../repoCleanupRecovery.js');
    review = await inspectOrQueueCompletedReview({ agentId, repoPath: sourceWorkspace, branch: branchName,
      prUrl: observed.prUrl, headSha: delivery.headSha, worktreePath, forgeAccount, repairEvidence: delivery.evidence }).catch(() => ({ disposition: 'held', reason: 'completed-review-inspection-unavailable' }));
  }
  if (review?.disposition === 'queued-review') {
    await record('pending', review.reason, { taskId: review.taskId });
    return { verified: false, skipReason: review.reason, issues, observed, recoveryTaskId: review.taskId };
  }
  return blockWith(review?.reason || delivery.reason || 'completed-review-target-unverified', { issues, observed });
}

async function fileDivergenceRecovery({ agentId, task, appId, sourceWorkspace, branchName, worktreePath, observed, issues, record, blockWith, agentState }, retirement) {
  const stateConfig = (await loadState().catch(() => null))?.config;
  if (stateConfig && stateConfig.autoApproveInvestigations !== true) {
    emitLog('info', `🔎 Diverged branch ${branchName} after ${agentId} deferred to scheduled branch-reconcile`, { agentId, branchName, taskId: task?.id });
    // Scheduling reconciliation preserves the checkout, but does not discharge its owner's cleanup obligation.
    if (agentState?.result?.cleanupPending === true) return blockWith('deferred-to-branch-reconcile', { issues, observed });
    if (record) await record('verified', 'deferred-to-branch-reconcile', { unresolved: 0 });
    return { verified: true, skipReason: 'deferred-to-branch-reconcile', issues, observed, recoveryTaskId: null };
  }
  // The recovery task filed below is the investigation, so this line only records the divergence; filing failures still warn.
  emitLog('info', `🔎 Repo state diverged after ${agentId}: ${issues.map(i => i.code).join(', ')}`, { agentId, branchName, taskId: task?.id });

  const recoveryTaskId = await fileRepoStateRecoveryTask({
    agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId, retirement,
  }).catch(err => {
    emitLog('warn', `Failed to file repo-state recovery task for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  return { verified: false, skipReason: null, issues, observed, recoveryTaskId };
}

/** Persist the exact obligation before retirement, so a refusal or restart
 * cannot lose it. A merged delivery retires directly; anything else is unmerged
 * work for a recovery agent. Neither answer is deletion authority.
 */
async function prepareRecoveryRetirement({ agentId, appId, app: taskApp, sourceWorkspace, branchName, worktreePath, observed }) {
  // A task naming an app is bound to exactly that app: a missing or mismatched one
  // refuses rather than falling through to another. Only an app-less task resolves
  // the managed app from the trusted repository, and only on one exact match.
  let app = taskApp;
  if (!appId) {
    const scope = await resolveRetirementApp(sourceWorkspace);
    if (!scope.app) return { reason: scope.reason };
    app = scope.app;
  }
  if (!app?.id || !app.repoPath || resolve(app.repoPath) !== resolve(sourceWorkspace)) return { reason: 'retirement-app-unavailable' };
  const trees = await listWorktrees(sourceWorkspace);
  const matches = trees.filter(tree => shortBranch(tree.branch) === branchName
    && (!worktreePath || resolve(tree.path) === resolve(worktreePath)));
  if (matches.length !== 1 || !isGitCommitSha(matches[0].head)) {
    return { reason: 'retirement-exact-inventory-unavailable' };
  }
  const tree = matches[0];
  const release = { branch: branchName, path: worktreePath || tree.path, head: tree.head,
    locked: tree.locked === true, lockReason: tree.lockReason ?? null };
  const { recordBranchReconcileOutcome, recordBranchReconcileCheckout } = await import('../branchReconcileOutcome.js');
  const outcome = await recordBranchReconcileCheckout(app.id, release);
  if (!outcome?.remaining?.some(row => row.path === release.path && row.head === release.head)) return { reason: 'retirement-inventory-unavailable' };
  if (release.locked) {
    await recordBranchReconcileOutcome(app.id, { status: 'incomplete', reason: 'retirement-worktree-locked',
      nextAction: 'Keep the checkout locked; its owner must explicitly release it before another retirement attempt.' });
    return { reason: 'retirement-worktree-locked' };
  }
  const { readMergedDelivery } = await import('../heldCheckoutRecovery.js');
  const integrated = await readMergedDelivery(sourceWorkspace, release);
  if (integrated === null) return { reason: 'delivery-evidence-unavailable' };
  return { appId: app.id, integrated, retirement: { release } };
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
    `Keep the retained worktree ${worktreePath} intact until branch-reconcile removes it. A merged checkout is retired directly through the exact branch-reconcile inventory; unmerged work stays. Do not copy the checkout into an archive.`,
  [REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT]: ({ branchName }) =>
    `Keep local branch ${branchName} until branch-reconcile removes it with ok:true and branchDeleted:true. Missing checkout or merged status is not permission for shell deletion.`,
  [REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT]: ({ branchName }) =>
    `Leave remote branch ${branchName} to the service's fresh exact-head cleanup. An advanced or unreadable ref is a hold; do not use a generic delete API or merge deletion flag.`,
  [REPO_STATE_ISSUES.BRANCH_UNMERGED]: ({ base }) =>
    `The branch has work not proven integrated in ${base}. Inspect whether it remains wanted, finish its draft PR, review and required checks, then complete the authorized merge. Preserve all unmerged or superseded work for explicit review; do not merge into the primary checkout or discard it.`,
  // Forge-aware: `driveToMerge` emits a `gh pr merge` procedure, which a GitLab
  // recovery agent cannot run. Its non-gh caveats still apply on either forge —
  // merge from the repo ROOT and preserve all checkout/ref evidence.
  [REPO_STATE_ISSUES.PR_UNMERGED]: ({ prUrl, prNumber, forgeCli, mergeHandoff }) => (forgeCli === 'glab'
    ? `Finish the merge request${prUrl ? ` ${prUrl}` : ''}: fix failing pipeline jobs and resolve review threads, retain delivery ownership until required checks and reviews pass, recheck CI, applicable reviews and forge merge eligibility for the same full head SHA, then merge from the repo ROOT with "glab mr merge ${prNumber ?? '<iid>'} --yes --sha <ci-verified-sha>" using that verified SHA while preserving source branches and checkouts until delivery is confirmed. Independently confirm the forge reports this exact merge request as MERGED; never request source-branch deletion during merge.`
    : `Finish the pull request${prUrl ? ` ${prUrl}` : ''}. ${driveToMerge(prUrl || '<num>', { mergeHandoff })}`),
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
async function fileRepoStateRecoveryTask({ agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId, retirement = null }) {
  const appName = task?.metadata?.appName || appId || 'PortOS';
  const base = observed.defaultBranch || 'the default branch';
  // The handoff is opt-in per app; a lookup failure keeps it off (the safe default).
  const ownerApp = appId ? await (await import('../apps.js')).getAppById(appId).catch(() => null) : null;
  const ctx = { branchName, base, prUrl: observed.prUrl, prNumber: observed.prNumber, worktreePath, forgeCli: observed.forgeCli,
    mergeHandoff: isMergeHandoffEnabled(ownerApp?.mergeHandoffMinQueuedRuns) };

  const retirementInstructions = `Only after independently confirming delivery through the forge (this exact PR/MR reports MERGED), request branch-reconcile through POST /api/cos/schedule/trigger with ${JSON.stringify({ taskType: 'branch-reconcile', appId })} using authenticated PortOS transport. Keep checkout and refs for its exact inventory and retirement: a merged checkout is removed with its branch. Report cleanup pending until branch-reconcile removes it with ok:true and branchDeleted:true. Do not copy the checkout into an archive.`;
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
    'Your mission has TWO required parts:',
    '1. Resolve the diverged branch/worktree: finish and merge the PR if it contains valid task work, or clean up the worktree and branch if the work is already superseded or unneeded.',
    `2. Investigate WHY the original agent (${agentId}) exited without completing delivery/cleanup cleanly, and fix or file an issue for the underlying PortOS pipeline cause so it does not happen again.`,
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
    `Rules: preserve wanted unmerged work until it is delivered. Retirement requires service-verified merged delivery: a PR merged at the exact head, or merged commits (on ${base} or inside a later merged PR head) with a clean checkout. A merged checkout is removed in place; do not copy it into an archive. `
      + `Other agents are running concurrently with their own worktrees and branches; touch ONLY ${branchName} and its worktree. `
      + `Do not switch branches in ${sourceWorkspace} itself.`,
  ].join('\n');

  const head = await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace)
    .then(result => result.exitCode === 0 ? result.stdout.trim() : null).catch(() => null);
  if (!isGitCommitSha(head)
    || (retirement && retirement.release.head !== head)) return null;
  const observation = processAuditFingerprint({ branchName, worktreePath, head, prUrl: observed.prUrl,
    codes: issues.map(issue => issue.code).sort(), merged: observed.branchMerged,
    remotePresent: observed.remoteBranchPresent, prState: observed.prState,
    // Stable observation: periodic checks alone do not create new work.
    work: 'delivery-repair' });
  const { reserveRepoCleanupRecovery, recordRepoCleanupRecovery, recordCleanupOutcome } = await import('../cos/cosAgentLifecycle.js');
  const reservation = await reserveRepoCleanupRecovery(agentId, branchName, observation);
  if (!reservation?.admitted) {
    await recordCleanupOutcome(agentId, { status: 'blocked', reason: reservation?.reason || 'cleanup-observation-unavailable', branch: branchName, path: worktreePath });
    return null;
  }

  // Completion observes this exact inventoried target; without it a
  // retirement-only recovery has no deterministic criterion (#16059).
  const cleanupTarget = retirement && appId ? { appId, release: retirement.release } : null;
  const created = await addTask({
    description: `${RECOVERY_TASK_PREFIX} Finish incomplete cleanup for branch ${branchName} in ${appName}`,
    priority: 'HIGH',
    app: appId || undefined,
    isRecovery: true,
    metadata: repositoryCleanupRecoveryMetadata({ parentAgentId: agentId, parentTaskId: task?.id || null,
      attempt: reservation.attempt, observation, target: cleanupTarget }),
    context,
    useWorktree: false,
  }, 'internal');

  await recordRepoCleanupRecovery(agentId, branchName, observation, { phase: created?.id ? 'dispatched' : 'blocked', taskId: created?.id || null });
  await recordCleanupOutcome(agentId, { status: 'pending', reason: 'cognitive-review-pending', branch: branchName, path: worktreePath, taskId: created?.id || null });
  if (created?.duplicate) {
    emitLog('info', `🔎 Repo-state recovery for ${branchName} already queued as ${created.id}`, { agentId, branchName });
    // Never bind an unrelated task matched only by description deduplication.
    const duplicate = await getTaskById(created.id).catch(() => null);
    const origin = duplicate?.metadata?.recoveryOrigin;
    const sameScope = !!cleanupTarget && isDeepStrictEqual(duplicate?.metadata?.retirementReview, cleanupTarget);
    if (origin?.parentAgentId !== agentId || origin?.parentTaskId !== task?.id
      || origin?.subsystem !== 'repository-cleanup' || !sameScope) return null;
  }
  emitLog('info', `🔧 Filed repo-state recovery task for ${branchName} (${issues.length} issue(s))`, { agentId, branchName, appName });
  return created?.id || null;
}
