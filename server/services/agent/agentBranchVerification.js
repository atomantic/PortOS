/** Verify the observed state of each completed agent branch and drive its delivery or retirement. */

import { sameCheckoutPath } from '../../lib/pathContainment.js';
import { hasClaimFlowContract } from '../../lib/claimFlowTaskTypes.js';
import { readGitCommonDirectory } from '../../lib/gitRepositoryIdentity.js';
import { hasClaimCheckoutBindings, isGitCommitSha, shortBranch, findValidCheckoutCaptures } from '../completedCheckoutEvidence.js';
import { resolveRetirementApp } from '../retirementAppScope.js';
import { readLocalBranchPresence, readCheckoutPathPresence, inspectOpenDeliveryRepair } from '../repoCleanupObservation.js';
import { join, resolve } from 'path';
import { emitLog } from '../cos/cosEvents.js';
import { getTaskById } from '../cos/cosTaskStore.js';
import { getDefaultBranch } from '../git/status.js';
import { hasBranchMergeEvidence } from '../git/branchEvidence.js';
import { listWorktrees } from '../worktreeManager.js';
import { listRemoteHeads } from '../branchReconcile.js';
import { readAllTasksFlat } from '../investigationTaskProducer.js';
import { execGit } from '../../lib/execGit.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isTruthyMeta } from './agentState.js';
import { resolveTaskTargetBranch } from '../../lib/taskTargetBranch.js';
import { leavesPrForHuman, resolvePrCompletion, PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { probePrForBranch, probeChangeRequestState } from '../prProbe.js';
import { parsePullRequestUrl } from '../../lib/gitForge.js';
import {
  REPO_STATE_ISSUES, REPO_STATE_SKIPS, classifyRepoStateIssues, repoStateVerificationEnabled,
  resolveRepoStateExpectation,
} from '../../lib/repoStateExpectations.js';
import { getOriginInfo } from '../../lib/gitRemote.js';
import { readClaimOwnershipAgents } from '../cos/cosClaimOwnership.js';
import { claimCheckoutOwner } from '../../lib/claimContinuation.js';
import { settleReleasedSelectionHistory, settleAbsentCheckout } from './agentAbsentCheckoutSettlement.js';
import { canonicalRepository, skipped, branchLedger, resolveCheckoutHold } from './agentRepoCleanupLedger.js';
import { fileDivergenceRecovery } from './agentRepoStateRecoveryTask.js';

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
    return worktrees.some(wt => (worktreePath ? sameCheckoutPath(wt.path, worktreePath) : shortBranch(wt.branch) === branchName));
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

export async function verifyRunBranches(input) {
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
      && !trees.some(tree => shortBranch(tree.branch) === branch || sameCheckoutPath(tree.path, capture.path))
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
