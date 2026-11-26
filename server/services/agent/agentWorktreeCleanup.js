/**
 * Retires completed agent worktrees and reconciles their pull-request delivery.
 */

import { isLegacyDeepAudit } from '../../lib/auditWorkflow.js';
import { realpath, rm } from 'node:fs/promises';
import { PORTOS_APP_ID } from '../../lib/appIdentity.js';
import { join } from 'path';
import { emitLog } from '../cos/cosEvents.js';
import { updateTask, getTaskById, getAllTasks } from '../cos/cosTaskStore.js';
import { getAgentRecord, getAgent, updateAgent, recordRepoStateVerification, recordCleanupOutcome } from '../cos/cosAgentLifecycle.js';
import { getDefaultBranch, getRepoBranches } from '../git/status.js';
import { push } from '../git/sync.js';
import { createPR, generatePRDescription, requestCopilotReview, suggestPRTitle } from '../git/prs.js';
import { deleteBranch } from '../git/cleanup.js';
import { hasBranchMergeEvidence } from '../git/branchEvidence.js';
import { resolveForgeForRepo } from '../forgeAuth.js';
import { claimCheckoutOwnerReason } from '../../lib/claimContinuation.js';
import { isTruthyMeta } from './agentState.js';
import { canonicalizePath } from '../../lib/pathContainment.js';
import { PATHS } from '../../lib/fileUtils.js';
import { execGit } from '../../lib/execGit.js';
import { doneSentinelCandidateNames } from '../../lib/agent/agentSentinel.js';
import { isRetryHoldOwner, clearedRetryHoldMetadata } from '../../lib/taskRetryHold.js';
import { DELIVERY_RECOVERY_BLOCKED_CATEGORIES } from '../../lib/taskBlockCategories.js';
import { resolveTaskTargetBranch, resolveTaskRemoteBranch } from '../../lib/taskTargetBranch.js';
import { parsePullRequestUrl } from '../../lib/gitForge.js';
import { PR_COMPLETIONS, resolvePrCompletion, PR_COMPLETION_VALUES, PR_CREATION, PR_MISSING_CATEGORY, leavesPrForHuman, prClaimWasVerified } from '../../lib/prDisposition.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, normalizeReviewers } from '../../lib/reviewerConfig.js';
import { findPullRequestForBranch } from '../github.js';
import { findValidCheckoutCaptures, isGitCommitSha, readCompletedCheckoutIdentity } from '../completedCheckoutEvidence.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents as readClaimOwnershipStateAgents } from '../cos/cosClaimOwnershipState.js';
import { lockfileDeliverable, recordTaskResumePointer, resolveTaskResumePatch, runtimeResumePatch } from './agentResumePointers.js';
import { spawnReviewLoopFollowUp } from './agentFollowUpSpawning.js';

export { lockfileDeliverable, recordTaskResumePointer, resolveTaskResumePatch };
export { resolveResumePointer, resumePointerMetadata } from './agentResumePointers.js';
export { spawnReviewLoopFollowUp };

// In-flight cleanup per agentId, so two completion paths racing to clean the
// SAME agent coalesce onto one run instead of tripping over each other.
//
// A completing agent reaches cleanup twice by design: the runner path
// (`handleAgentCompletion` → `runAgentCompletionCleanup`) AND the spawner's
// `finally` safety net (agentTuiSpawning.js / agentCliSpawning.js), which fires
// unconditionally so a throw from `finalizeAgent` can never strand a worktree.
// Neither knows about the other, and they are driven by independent events, so
// they overlap. The loser then ran `git status --porcelain` while the winner was
// mid-`git worktree remove --force`, saw the in-progress deletions as ` D <path>`
// dirt, and reported "Worktree preserved — uncommitted changes detected" for a
// worktree that removed cleanly milliseconds later — a false warning AND a false
// user notification on a successful run (observed on agent-ce67bb09, whose PR had
// already merged). Sanctioned by the Security Model's re-entrancy-guard carve-out:
// this is one actor's duplicate in-flight operation, not two competing humans.
const inFlightCleanups = new Map();
// Fail closed even when the agent store cannot persist the hold. Normally the
// persisted metadata owns recovery across restarts; this covers sibling cleanup
// callbacks in the process where that write failed.
const publicationHolds = new Map();


/**
 * Clean up a worktree for a completed agent.
 * Reads worktree metadata from the agent's registered state and removes the worktree.
 * `prCreation` (see `PR_CREATION`) decides who opens the change request:
 * `'always'` pushes and creates one instead of auto-merging; `'if-missing'` does
 * that only when the forge confirms the agent — which owned its own PR workflow —
 * opened none (#3733); `'never'` leaves it entirely to the agent.
 * `prCompletion` decides whether the PR is reviewed then merged, merged after
 * green CI, or intentionally left open. The explicit leave-open policy does
 * not spawn a post-PR agent.
 * `reviewers` is the ordered reviewer list (e.g. `[codex, antigravity, copilot]`); the native
 * GitHub Copilot review is pre-requested here only when copilot LEADS the list (otherwise
 * the follow-up requests it at its turn so Copilot sees the post-fix diff). `reviewStopMode`
 * (`all`/`on-findings`/`on-clean`) is threaded into the follow-up's
 * metadata. CLI reviewers (claude/antigravity/codex/grok) are always driven by the follow-up agent,
 * which works on any forge; copilot is GitHub-only and dropped on non-GitHub remotes.
 * When skipMerge is true (review-loop follow-up agents), the cleanup never auto-merges
 * the worktree branch into the source workspace because `gh pr merge` already handled it.
 * Otherwise, merges the worktree branch back to the source branch on success.
 *
 * Re-entrant per `agentId`: a second call that arrives while the first is still
 * running joins it and resolves with the SAME warnings rather than starting a
 * competing pass (see `inFlightCleanups`). The joiner's `options` are therefore
 * ignored — one completing agent gets one cleanup, and the two duplicate callers
 * this guards against derive their options from the same task metadata anyway.
 */
export async function cleanupAgentWorktree(agentId, success, options = {}) {
  const existing = inFlightCleanups.get(agentId);
  // Join the pass already underway. Its warnings are the run's warnings — the
  // duplicate caller must not re-derive them from a half-removed worktree.
  if (existing) return existing;

  const run = runCleanupAgentWorktree(agentId, success, options);
  const settled = run.finally(() => { inFlightCleanups.delete(agentId); });
  inFlightCleanups.set(agentId, settled);

  // The audit hangs off THIS wrapper rather than off `runCleanupAgentWorktree`,
  // so its disposition handlers do not each need the call, and because every
  // completion path — runner, TUI `finish()`, direct-CLI, the manual stop in
  // agentManagement — funnels through here. One `.then` on `run` means a
  // duplicate completion callback that JOINS the in-flight pass audits once.
  //
  // Detached, NOT awaited: it makes two network calls and nothing downstream
  // consumes its result, while the callers awaiting cleanup still owe the run a
  // retry-hold release, a lane release and a shell-session kill. Only
  // `originalTask` is captured — closing over `options` would pin the whole TUI
  // output buffer for the duration of the probes.
  const originalTask = options?.originalTask || null;
  run.then(
    (warnings) => auditRepoState(agentId, success, originalTask, warnings)
      .catch(err => emitLog('warn', `🔎 Repo-state audit failed for ${agentId}: ${err.message}`, { agentId })),
    // A cleanup that threw has no end state to audit; `settled` still rejects.
    () => {}
  // Nothing awaits this chain, so a throw from the reporting itself would surface
  // as an unhandled rejection and take the process down outside any request.
  ).catch(() => {});

  return settled;
}

/**
 * Post-cleanup repo-state audit — did this run actually leave the repository the
 * way its task asked? `verifyAgentRepoState` itself decides whether the run is
 * even auditable, and files a recovery task when it is not clean.
 *
 * Imported lazily so the cleanup graph doesn't pull the verification module's
 * branch-reconcile / apps / github reach into every consumer's module-init.
 */
async function auditRepoState(agentId, success, originalTask, warnings) {
  const { verifyAgentRepoState } = await import('./agentRepoStateVerification.js');
  // `getAgentRecord`, not `getAgent` — the audit reads three worktree metadata
  // fields and has no use for the run's whole output.txt.
  const agentState = await getAgentRecord(agentId).catch(() => null);
  if (publicationHolds.has(agentId) || ['running', 'blocked'].includes(agentState?.metadata?.publicationValidation?.status)) return;
  await verifyAgentRepoState({
    agentId,
    task: originalTask,
    agentState,
    success,
    cleanupWarnings: warnings || [],
  });
}

// A disposition is selected once, after forge evidence is available. Merge is
// still governed by success/skipMerge even for stand-down: the existing local
// cleanup contract is independent of who opened the PR.
const WORKTREE_DISPOSITIONS = Object.freeze({
  'not-a-worktree': Object.freeze({ merge: false }),
  discard: Object.freeze({ merge: false }),
  'open-pr': Object.freeze({ merge: false }),
  'stand-down': Object.freeze({}),
  'stand-down-uncertain': Object.freeze({}),
  'stranded-pr-handoff': Object.freeze({}),
  'delivered-pr': Object.freeze({ merge: false }),
  'merge-or-preserve': Object.freeze({}),
});

/** Pure policy: unknown forge evidence must never authorize a duplicate PR. */
export function resolveWorktreeDisposition({ isWorktree, success, prCreation, discardWorktree, skipMerge, prClaimVerdict }) {
  let name = 'merge-or-preserve';
  if (isWorktree === false) name = 'not-a-worktree';
  else if (discardWorktree) name = 'discard';
  else if (prCreation === PR_CREATION.IF_MISSING) {
    if (success) {
      if (prClaimVerdict?.category === PR_MISSING_CATEGORY) name = 'open-pr';
      else name = prClaimWasVerified(prClaimVerdict) ? 'stand-down' : 'stand-down-uncertain';
    } else if (prClaimVerdict?.mergedExactHead === true) {
      name = 'delivered-pr';
    } else if (prClaimVerdict?.status === 'found' && prClaimVerdict.url) {
      name = 'stranded-pr-handoff';
    }
  } else if (success && prCreation === PR_CREATION.ALWAYS) name = 'open-pr';

  return {
    disposition: name,
    merge: success && !skipMerge,
    ...WORKTREE_DISPOSITIONS[name],
  };
}

async function worktreeCleanupContext(agentId, options) {
  const agentState = await getAgent(agentId).catch(() => null);
  const metadata = agentState?.metadata;
  const claimBranches = [...new Set([
    ...(Array.isArray(metadata?.claimBranches) ? metadata.claimBranches : []),
    metadata?.claimBranch,
  ].filter(b => typeof b === 'string' && b.trim()))];
  if (!metadata?.isWorktree || metadata.isPersistentWorktree) {
    return {
      isWorktree: false,
      claimBranches,
      sourceWorkspace: metadata?.sourceWorkspace || metadata?.workspacePath || null,
      agentState,
      remoteTimeoutMs: options?.remoteTimeoutMs,
    };
  }
  const { sourceWorkspace, worktreeBranch } = metadata;
  if (!sourceWorkspace || !worktreeBranch) {
    return { isWorktree: false, claimBranches, sourceWorkspace: sourceWorkspace || metadata?.workspacePath || null, agentState, remoteTimeoutMs: options?.remoteTimeoutMs };
  }
  const normalized = cleanupOptions(options);
  return {
    ...normalized,
    ...(normalized.originalTask?.metadata?.prCompletion === PR_COMPLETIONS.DRAFT ? { prCompletion: PR_COMPLETIONS.LEAVE_OPEN, skipMerge: true } : {}),
    isWorktree: true, agentId, sourceWorkspace, worktreeBranch, claimBranches,
    discardWorktree: isTruthyMeta(normalized.originalTask?.metadata?.discardWorktree),
    worktreePath: metadata.workspacePath || join(PATHS.worktrees, agentId),
    publicationValidation: publicationHolds.get(agentId) || metadata.publicationValidation,
    runtimeVerificationRequested: agentState?.result?.taskOutcome?.recovery?.mode === 'runtime',
    dependencyWaitRequested: agentState?.result?.taskOutcome?.recovery?.mode === 'dependency-wait',
    startedAt: agentState?.startedAt, instanceId: metadata.instanceId,
    taskId: agentState?.taskId || normalized.originalTask?.id,
    securityScan: metadata.securityScan,
    securityScanControl: metadata.securityScanControl,
    warnings: [],
  };
}

function reconcileClaimRemoteBranch({ sourceWorkspace, branch, head, merged, ownerHold, remoteOpts }) {
  return merged
    ? deleteClaimRemoteBranch(sourceWorkspace, branch, head, ownerHold, remoteOpts)
    : retainedClaimRemoteBranch(sourceWorkspace, branch, remoteOpts);
}

async function cleanupUncapturedClaimBranch({ sourceWorkspace, branch, remoteOpts, getSnapshot, listWorktrees, readLocalBranchPresence, held }) {
  // An observed holder or ref is enough to retain work without further
  // probes. Only a fresh targeted read can establish clean absence, including
  // malformed loose refs that Git omits from enumeration.
  const snapshot = await getSnapshot();
  const couldBeAbsent = snapshot && !snapshot.tips.has(branch)
    && !snapshot.worktrees.some(tree => tree.branch === `refs/heads/${branch}`);
  const [trees, refPresent] = couldBeAbsent ? await Promise.all([
    listWorktrees(sourceWorkspace).catch(() => null), readLocalBranchPresence(sourceWorkspace, branch),
  ]) : [null, null];
  if (!trees || refPresent !== false || trees.some(tree => tree.branch === `refs/heads/${branch}`)) {
    return held(branch, 'checkout identity unavailable');
  }
  const remote = await retainedClaimRemoteBranch(sourceWorkspace, branch, remoteOpts);
  return remote ? held(branch, remote) : null;
}

async function verifyClaimWorktreeRemoval({ agentId, sourceWorkspace, branch, capture, merged, owner, holder, trees }) {
  const reason = await owner();
  if (reason) return reason;
  if (!holder || holder.branch !== `refs/heads/${branch}` || holder.head !== capture.head) return 'checkout-changed';
  const current = await readCompletedCheckoutIdentity({
    repoPath: sourceWorkspace, branch, path: capture.path, head: capture.head, worktrees: trees,
  }).catch(() => null);
  if (!current) return 'checkout-changed';
  // Only the consumed, untracked sentinel belongs to completion cleanup.
  // Leave Git to reject a dirty checkout even when its exact HEAD was merged.
  const sentinelNames = doneSentinelCandidateNames(agentId);
  const sentinels = await execGit(['ls-files', '--others', '--exclude-standard', '-z', '--', ...sentinelNames], capture.path)
    .catch(() => null);
  if (!sentinels) return 'checkout state unavailable';
  const untracked = new Set(sentinels.stdout.split('\0'));
  await Promise.all(sentinelNames.filter(name => untracked.has(name))
    .map(name => rm(join(capture.path, name), { force: true }).catch(() => null)));
  if (!merged) {
    const base = await getDefaultBranch(sourceWorkspace, { strict: true, allowRemote: false }).catch(() => null);
    const [status, contained] = await Promise.all([
      execGit(['status', '--porcelain', '--untracked-files=all'], capture.path, { ignoreExitCode: true }).catch(() => null),
      base ? execGit(['merge-base', '--is-ancestor', capture.head, `refs/remotes/origin/${base}`], sourceWorkspace, { ignoreExitCode: true }).catch(() => null) : null,
    ]);
    if (status?.exitCode !== 0 || status.stdout.trim() || contained?.exitCode !== 0) return 'unmerged work retained';
  }
  return null;
}

async function cleanupCapturedClaimBranch({ agentId, sourceWorkspace, branch, capture, merged, remoteOpts, deps, held }) {
  const { listWorktrees, readCheckoutPathPresence, readLocalBranchPresence, forceRemoveWorktreeDir, deleteCompletedLocalBranch } = deps;
  const owner = () => readClaimOwnershipStateAgents().then(agents => claimCheckoutOwnerReason({
    branchName: branch, holderPath: capture.path, sourceWorkspace, agents, ignoreIds: [agentId],
  }));
  const ownerHold = () => withClaimOwnershipLock(owner).catch(() => 'claim-ownership-unreadable');
  const initialHold = await ownerHold();
  if (initialHold) return held(branch, initialHold);

  // Each local mutation is one ownership section: a bind lands before its owner
  // read or after it settles. Remote calls stay outside, behind `ownerHold`.
  const deleteLocal = async () => {
    let reason;
    const deleted = await withClaimOwnershipLock(() => deleteCompletedLocalBranch(sourceWorkspace, branch, capture.head, {
      beforeMutation: async () => {
        reason = await owner().catch(() => 'claim-ownership-unreadable');
        if (reason) throw new Error(reason);
      },
    })).catch(() => false);
    return deleted ? null : reason || 'local branch deletion unverified';
  };

  try {
    const [trees, pathPresent, refPresent] = await Promise.all([
      listWorktrees(sourceWorkspace).catch(() => null), readCheckoutPathPresence(capture.path), readLocalBranchPresence(sourceWorkspace, branch),
    ]);
    if (!trees || pathPresent === null || refPresent === null) return held(branch, 'checkout state unavailable');
    const holder = trees.find(tree => canonicalizePath(tree.path) === canonicalizePath(capture.path));
    if (!holder) {
      if (pathPresent || trees.some(tree => tree.branch === `refs/heads/${branch}`)) return held(branch, 'checkout changed');
      if (refPresent) {
        const local = merged ? await deleteLocal() : 'unmerged work retained';
        if (local) return held(branch, local);
      }
      const remote = await reconcileClaimRemoteBranch({ sourceWorkspace, branch, head: capture.head, merged, ownerHold, remoteOpts });
      return remote ? held(branch, remote) : null;
    }

    const removal = await withClaimOwnershipLock(async () => {
      const reason = await owner();
      if (reason) return { removed: false, reason };
      return forceRemoveWorktreeDir(sourceWorkspace, capture.path, {
        verifyRemoval: (currentHolder, currentTrees) => verifyClaimWorktreeRemoval({
          agentId, sourceWorkspace, branch, capture, merged, owner, holder: currentHolder, trees: currentTrees,
        }),
        force: false,
      });
    }).catch(() => ({ removed: false, reason: 'claim-ownership-unreadable' }));
    if (!removal.removed) return held(branch, removal.reason || 'worktree removal unverified');
    const local = await deleteLocal();
    if (local) return held(branch, local);
    const remote = await reconcileClaimRemoteBranch({ sourceWorkspace, branch, head: capture.head, merged, ownerHold, remoteOpts });
    if (remote) return held(branch, remote);
    emitLog('info', `🌳 Cleaned up claim branch ${branch} for ${agentId} (${merged ? 'PR merged' : 'empty clean branch'})`, { agentId, branchName: branch });
    return null;
  } catch {
    return held(branch, 'cleanup failed or is unverified');
  }
}

async function cleanupClaimBranchWorktrees(agentId, { sourceWorkspace, claimBranches, agentState, remoteTimeoutMs }) {
  if (!sourceWorkspace || !Array.isArray(claimBranches) || !claimBranches.length) return [];
  const remoteOpts = remoteTimeoutMs ? { timeout: remoteTimeoutMs } : {};
  const [
    { probePrForBranch, isExactMergedPrHead },
    { readCheckoutPathPresence, readLocalBranchPresence },
    { listWorktrees, forceRemoveWorktreeDir, deleteCompletedLocalBranch },
  ] = await Promise.all([
    import('../prProbe.js'), import('../repoCleanupObservation.js'), import('../worktreeManager.js'),
  ]);
  const deps = { listWorktrees, readCheckoutPathPresence, readLocalBranchPresence, forceRemoveWorktreeDir, deleteCompletedLocalBranch };
  const warnings = [];
  const held = (branch, reason) => `Claim cleanup ${branch} incomplete — ${reason}`;
  const repository = await realpath(sourceWorkspace).catch(() => null);
  if (!repository) return claimBranches.map(branch => held(branch, 'repository unavailable'));
  let uncapturedInventory;
  const getSnapshot = () => {
    uncapturedInventory ??= import('../repoBranchSnapshot.js')
      .then(({ readRepoBranchSnapshot }) => readRepoBranchSnapshot(sourceWorkspace))
      .catch(() => null);
    return uncapturedInventory;
  };
  for (const branch of claimBranches) {
    const captures = findValidCheckoutCaptures(agentState, { branch, repoPath: repository });
    const capture = captures.length === 1 ? captures[0] : null;
    if (!capture) {
      const warning = await cleanupUncapturedClaimBranch({ sourceWorkspace, branch, remoteOpts, getSnapshot, listWorktrees, readLocalBranchPresence, held });
      if (warning) warnings.push(warning);
      continue;
    }
    const probe = await probePrForBranch(sourceWorkspace, branch).catch(() => null);
    const merged = isExactMergedPrHead(probe, capture.head);
    // A finished PR at another head is an earlier delivery on a reused claim
    // branch (a re-claim provisioned from the default branch), not this
    // checkout's work: the stand-down path below removes it only when clean
    // and contained in the default branch. An open PR still holds.
    if (!merged && !(probe?.readable === true && probe.prState !== 'OPEN')) {
      warnings.push(held(branch, 'merged head not verified'));
      continue;
    }
    const warning = await cleanupCapturedClaimBranch({ agentId, sourceWorkspace, branch, capture, merged, remoteOpts, deps, held });
    if (warning) warnings.push(warning);
  }
  return warnings;
}

// A stand-down or missing capture never authorizes remote deletion, but a
// surviving (or unreadable) remote must remain visible as unfinished cleanup.
async function retainedClaimRemoteBranch(repo, branch, opts = {}) {
  const ref = `refs/heads/${branch}`;
  const timeout = opts.timeout ?? 5000;
  const remote = await execGit(['ls-remote', '--heads', '--', 'origin', ref], repo,
    { ignoreExitCode: true, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).catch(() => null);
  if (remote?.exitCode !== 0) return 'remote branch state unavailable';
  const lines = remote.stdout.trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  const [head, actualRef, ...extra] = lines[0].split('\t');
  if (lines.length !== 1 || !isGitCommitSha(head) || actualRef !== ref || extra.length) return 'remote branch state unavailable';
  return 'remote branch retained';
}

async function claimRemoteTarget(repo, opts) {
  const [origin, pushes] = await Promise.all([
    execGit(['remote', 'get-url', 'origin'], repo, opts).catch(() => null),
    execGit(['remote', 'get-url', '--push', '--all', 'origin'], repo, opts).catch(() => null),
  ]);
  const urls = pushes?.stdout?.trim().split('\n').filter(Boolean) || [];
  return origin?.exitCode === 0 && pushes?.exitCode === 0 && urls.length === 1 && urls[0] === origin.stdout.trim() ? urls[0] : null;
}

// Use the remote name after checking its target: passing an expanded URL back
// to Git can apply an insteadOf rewrite a second time and reach another repo.
async function deleteClaimRemoteBranch(repo, branch, head, ownerHold, opts = {}) {
  const timeout = opts.timeout ?? 5000;
  const gitOpts = { ignoreExitCode: true, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
  const target = await claimRemoteTarget(repo, gitOpts);
  if (!target) return 'remote target unverified';
  const ref = `refs/heads/${branch}`;
  const remote = await execGit(['ls-remote', '--heads', '--', 'origin', ref], repo, gitOpts).catch(() => null);
  if (remote?.exitCode !== 0) return 'remote branch state unavailable';
  const lines = remote.stdout.trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  if (lines.length !== 1 || lines[0] !== `${head}\t${ref}`) return 'remote branch head changed';
  const reason = await ownerHold();
  if (reason) return reason;
  if (await claimRemoteTarget(repo, gitOpts) !== target) return 'remote target unverified';
  const deletion = await execGit(['push', '--no-follow-tags', `--force-with-lease=${ref}:${head}`, '--', 'origin', `:${ref}`], repo, gitOpts).catch(() => null);
  return deletion?.exitCode === 0 ? null : 'remote branch deletion failed or is unverified';
}

async function probeWorktreePr(context, success) {
  if (!context.isWorktree || context.discardWorktree || context.prCreation !== PR_CREATION.IF_MISSING) return null;
  const { worktreePath, worktreeBranch, agentOutput } = context;
  if (success) {
    const { verifyPrClaim } = await import('./agentPrVerification.js');
    // `agentOutput` (the run's output buffer) rides along so the probe can
    // recognize the parallel-claim stand-down the same way finalize did —
    // without it, cleanup would re-ask the forge, see "no PR", and open a
    // DUPLICATE of the change request the summary says already landed.
    const { extractFinalSummary } = await import('./agentSummaryExtraction.js');
    const agentSummary = extractFinalSummary(agentOutput);
    return verifyPrClaim({ task: context.originalTask, workspacePath: worktreePath, success: true, prExpected: true, agentSummary })
      .catch(err => ({ ok: false, category: 'forge-unreachable', message: err.message }));
  }
  const forge = await resolveForgeForRepo(worktreePath).catch(() => null);
  if (!forge) return { status: 'unavailable' };
  const found = await findPullRequestForBranch(worktreeBranch, { cwd: worktreePath, env: forge.env || null })
    .catch(() => ({ status: 'unavailable' }));
  if (found.status === 'found' && String(found.detail).toUpperCase() === 'MERGED' && found.headRefOid
    && !leavesPrForHuman(context.originalTask)) {
    const tip = await execGit(['rev-parse', '--verify', `refs/heads/${worktreeBranch}`], context.sourceWorkspace,
      { ignoreExitCode: true }).catch(() => null);
    if (tip?.exitCode === 0 && tip.stdout.trim() === found.headRefOid) return { ...found, mergedExactHead: true };
  }
  return found;
}

async function runCleanupAgentWorktree(agentId, success, options = {}) {
  const context = await worktreeCleanupContext(agentId, options);
  if (context.dependencyWaitRequested) {
    // Completion callers still hold the pre-finalize task snapshot. Only the
    // fresh accepted wait can retain this exact investigator generation,
    // including the interval between ready dispatch and successor claiming.
    const held = context.taskId ? await getTaskById(context.taskId) : null;
    const wait = held?.metadata?.investigationDependencyWait;
    if (held?.taskType === 'internal' && isTruthyMeta(held.metadata?.blockedSystemRecovery)
      && isTruthyMeta(held.metadata?.preserveOriginalBudget) && wait?.version === 1
      && ['waiting', 'ready'].includes(wait.phase) && ['blocked', 'pending', 'in_progress'].includes(held.status)
      && wait.sourceAgentId === agentId && wait.sourceStartedAt === context.startedAt
      && wait.instanceId === context.instanceId) return [];
  }
  if (context.runtimeVerificationRequested) {
    const held = context.taskId ? await getTaskById(context.taskId) : null;
    if (held?.metadata?.runtimeVerificationId === `${held.id}:${agentId}`
      && held.metadata.runtimeVerification?.agentId === agentId) return [];
  }
  if (['running', 'blocked'].includes(context.publicationValidation?.status)) {
    return [`Publication validation ${context.publicationValidation.status} for ${context.worktreeBranch}; worktree preserved at ${context.worktreePath}. Resume the task after resolving the validation outcome.`];
  }
  const verdict = await probeWorktreePr(context, success);
  const disposition = resolveWorktreeDisposition({ ...context, success, prClaimVerdict: verdict });
  reportWorktreeDisposition(context, disposition, verdict);
  switch (disposition.disposition) {
    case 'not-a-worktree':
      return cleanupClaimBranchWorktrees(agentId, context);
    case 'discard':
      return discardAgentWorktree(context);
    case 'open-pr':
      return openWorktreePullRequest(context);
    case 'delivered-pr':
      await mergeOrPreserveWorktree({ ...context, skipMerge: true }, disposition);
      break;
    case 'stranded-pr-handoff': {
      const released = await mergeOrPreserveWorktree(context, disposition);
      if (released?.cleanupIncomplete) {
        deferFollowUpWhileBranchHeld(context, verdict.url);
        break;
      }
      await handoffFollowUpAfterRelease(context, verdict.url, {
        prCompletion: PR_COMPLETION_VALUES.includes(context.prCompletion)
          ? context.prCompletion : PR_COMPLETIONS.REVIEW_THEN_MERGE,
      }, 'orphaned');
      break;
    }
    case 'stand-down':
    case 'stand-down-uncertain':
    case 'merge-or-preserve':
      await mergeOrPreserveWorktree(context, disposition);
      break;
  }
  return context.warnings;
}

function reportWorktreeDisposition({ agentId, worktreeBranch, prCreation, warnings }, { disposition }, verdict) {
  switch (disposition) {
    case 'open-pr':
      if (prCreation !== PR_CREATION.IF_MISSING) break;
      emitLog('warn', `🌳 ${agentId} owned its PR workflow but opened no pull request for ${worktreeBranch} — PortOS is opening one`, { agentId, branchName: worktreeBranch });
      warnings.push(`Agent ${agentId} was told to open its own pull request for ${worktreeBranch} but did not; PortOS opened it instead.`);
      break;
    case 'stand-down':
      emitLog('info', `🌳 ${agentId} opened its own pull request for ${worktreeBranch} — PortOS is standing down`, { agentId, branchName: worktreeBranch });
      break;
    case 'stand-down-uncertain': {
      const why = verdict?.category || 'nothing to verify against';
      emitLog('warn', `🌳 Could not confirm a pull request for ${worktreeBranch} (${why}) — keeping the branch rather than opening a possible duplicate`, { agentId, branchName: worktreeBranch });
      warnings.push(`Could not confirm a pull request for ${worktreeBranch} (${why}); the branch was preserved for manual follow-up rather than risking a duplicate PR.`);
      break;
    }
    case 'stranded-pr-handoff':
      emitLog('warn', `🌳 ${agentId} failed after opening ${verdict.url} — handing the PR to a follow-up so it isn't stranded`, { agentId, prUrl: verdict.url, branchName: worktreeBranch });
      warnings.push(`Agent ${agentId} failed after opening ${verdict.url}; a follow-up was queued to land it.`);
      break;
  }
}

function cleanupOptions({ prCreation = PR_CREATION.NEVER, prCompletion = null, requestCopilotReview: legacyRequestCopilotReview = false, reviewers, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerModels = null, reviewerEfforts = null, skipMerge = false, description = null, agentOutput = null, originalTask = null } = {}) {
  return { prCreation, prCompletion, legacyRequestCopilotReview, reviewers, usernames,
    optionalReviewers, reviewerMaxRounds, reviewStopMode,
    reviewerModels, reviewerEfforts, skipMerge, description, agentOutput, originalTask };
}

// A lockfile-only diff is a legitimate deliverable for dependency-updates only.
async function discardAgentWorktree({ agentId, sourceWorkspace, worktreeBranch }) {
  const { removeWorktree } = await import('../worktreeManager.js');
  emitLog('info', `🌳 Discarding worktree for reasoning agent ${agentId} (no merge, no PR)`, { agentId, branchName: worktreeBranch });
  // `discardDirt`: the discard prompt explicitly invites scratch edits ("only
  // the completion sentinel is kept"), and removeWorktree otherwise ABORTS on
  // any non-lockfile dirt — so an agent that took its own prompt at its word
  // stranded a full checkout on disk, once per run, forever.
  const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false, discardDirt: true }).catch(err => {
    emitLog('warn', `🌳 Worktree discard failed for ${agentId}: ${err.message}`, { agentId });
    return { warnings: [`Worktree discard failed: ${err.message}`] };
  });
  return result?.warnings || [];
}

async function openWorktreePullRequest(context) {
  const { agentId, sourceWorkspace, worktreeBranch, worktreePath, warnings, description, agentOutput } = context;
  emitLog('info', `🌳 Opening PR for worktree agent ${agentId} branch ${worktreeBranch}`, { agentId, branchName: worktreeBranch });

  if (context.originalTask?.metadata?.app === PORTOS_APP_ID) {
    try {
      publicationHolds.set(agentId, { status: 'running' });
      await updateAgent(agentId, { metadata: { publicationValidation: { status: 'running', startedAt: new Date().toISOString() } } });
      const { validatePublication } = await import('../publicationValidation.js');
      const validation = await validatePublication(context);
      publicationHolds.set(agentId, validation);
      await updateAgent(agentId, { metadata: { publicationValidation: validation } });
      if (validation.status !== 'passed') {
        warnings.push(`Publication validation blocked for ${worktreeBranch}: ${validation.reason}. Worktree preserved at ${worktreePath}; resolve validation before resuming the task.`);
        return warnings;
      }
      publicationHolds.delete(agentId);
    } catch (error) {
      publicationHolds.set(agentId, { status: 'blocked', reason: 'recording-failed' });
      warnings.push(`Publication validation could not be recorded for ${worktreeBranch}: ${error.message}. Worktree preserved at ${worktreePath}.`);
      return warnings;
    }
  }

  const [pushResult, branchInfo] = await Promise.all([
    push(worktreePath, worktreeBranch).then(() => true).catch(err => {
      emitLog('warn', `🌳 Failed to push worktree branch ${worktreeBranch}: ${err.message}`, { agentId });
      return false;
    }),
    getRepoBranches(sourceWorkspace).catch(() => ({ baseBranch: null, devBranch: null }))
  ]);

  if (!pushResult) {
    warnings.push(`Push failed for branch ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`);
    emitLog('warn', `🌳 Push failed for ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`, { agentId, branchName: worktreeBranch });
    return warnings;
  }
  let targetBranch = branchInfo.baseBranch;
  if (!targetBranch) {
    targetBranch = await getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null) || 'main';
  }
  const prTitle = await suggestPRTitle(worktreePath, targetBranch, worktreeBranch, description);

  const prBody = await generatePRDescription(worktreePath, targetBranch, worktreeBranch, agentOutput, context.securityScan, context.securityScanControl);

  const prResult = await createPR(worktreePath, {
    title: prTitle,
    body: prBody,
    base: targetBranch,
    head: worktreeBranch,
    ...(context.originalTask?.metadata?.prCompletion === PR_COMPLETIONS.DRAFT ? { draft: true } : {})
  }).catch(err => {
    emitLog('warn', `🌳 Failed to create PR for ${worktreeBranch}: ${err.message}`, { agentId });
    return null;
  });

  if (!prResult?.success) return handlePrCreationFailure(context, prResult, targetBranch);
  if (context.originalTask?.metadata?.prCompletion === PR_COMPLETIONS.DRAFT) {
    const { verifyPrClaim } = await import('./agentPrVerification.js');
    const verdict = await verifyPrClaim({ task: context.originalTask, workspacePath: worktreePath, success: true, prExpected: true })
      .catch(() => ({ ok: false }));
    if (!verdict?.ok || !verdict.branch) {
      warnings.push(`Draft PR disposition could not be verified for ${worktreeBranch}; worktree preserved for review`);
      return warnings;
    }
  }
  return completeOpenedPullRequest(context, prResult);
}

async function handlePrCreationFailure({ agentId, sourceWorkspace, worktreeBranch, warnings, originalTask }, prResult, targetBranch) {
  const reason = prResult?.error || 'unknown error (createPR returned null or threw)';

  // "No commits between X and Y" means the agent made no code changes.
  // Clean up the worktree silently — nothing to review or merge.
  // Also delete the remote branch (it was pushed before PR creation).
  if (reason.includes('No commits between')) {
    emitLog('info', `🌳 No commits on ${worktreeBranch} vs ${targetBranch} — agent made no changes, cleaning up`, { agentId });
    await deleteBranch(sourceWorkspace, worktreeBranch, { remote: true }).catch(err => {
      emitLog('warn', `🌳 Remote branch delete failed for ${worktreeBranch}: ${err.message}`, { agentId });
      warnings.push(`Remote branch delete failed for ${worktreeBranch}: ${err.message}`);
    });
    const { removeWorktree } = await import('../worktreeManager.js');
    const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false, ...lockfileDeliverable(originalTask) }).catch(err => {
      emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
      return { warnings: [`Worktree cleanup failed for ${agentId}: ${err.message}`] };
    });
    warnings.push(...(result?.warnings || []));
    return warnings;
  }

  const cliName = prResult?.cli || 'gh';
  const authHint = prResult?.account
    ? ` (${cliName} authed as ${prResult.account} for ${prResult.owner})`
    : prResult?.owner
      ? ` (${cliName} on ${prResult.host || prResult.owner} — no account auto-pinned)`
      : '';
  emitLog('error', `🌳 PR creation failed for ${worktreeBranch}${authHint}: ${reason}`, { agentId, branchName: worktreeBranch, cli: prResult?.cli, account: prResult?.account, owner: prResult?.owner, host: prResult?.host });
  warnings.push(`PR creation failed for branch ${worktreeBranch}: ${reason}. Worktree preserved for manual PR creation.`);
  return warnings;
}

async function completeOpenedPullRequest(context, prResult) {
  const { agentId, sourceWorkspace, worktreeBranch, warnings, prCompletion,
    legacyRequestCopilotReview, reviewers, originalTask } = context;
  const { recordBranchCompletionPolicy } = await import('../branchCompletionPolicy.js');
  await recordBranchCompletionPolicy({ agentId, task: originalTask, repoPath: sourceWorkspace,
    branch: worktreeBranch, prUrl: prResult.url });
  const cliName = prResult.cli || 'gh';
  emitLog('success', `🌳 Created PR: ${prResult.url} (${cliName}${prResult.account ? ` authed as ${prResult.account}` : ''})`, { agentId, branchName: worktreeBranch, cli: prResult.cli, account: prResult.account, owner: prResult.owner, host: prResult.host });

  // Production completion paths pass a resolver-backed policy. Keep the
  // former option as a narrow compatibility fallback for direct callers.
  const resolvedPrCompletion = PR_COMPLETION_VALUES.includes(prCompletion)
    ? prCompletion
    : (legacyRequestCopilotReview ? PR_COMPLETIONS.REVIEW_THEN_MERGE : PR_COMPLETIONS.MERGE_ON_GREEN);
  const runsReviewLoop = resolvedPrCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  // Keep the pre-reviewer-chain API contract for direct callers: the legacy
  // flag explicitly requested Copilot, whereas an explicitly supplied empty
  // list means the caller opted into no reviewers. Production callers pass
  // the resolved list, so a fresh install remains reviewer-free by default.
  const reviewerList = reviewers === undefined
    ? (legacyRequestCopilotReview ? [DEFAULT_REVIEWER] : [...DEFAULT_REVIEWERS])
    : normalizeReviewers({ reviewers });
  await preRequestWorktreeReview(context, prResult, runsReviewLoop, reviewerList);

  // JIRA remains a legacy human hand-off: configured reviewers can still
  // run, but the follow-up must not merge. An explicit leave-open policy is
  // different — opening the PR is the entire requested outcome.
  const leaveOpen = leavesPrForHuman(originalTask);

  // Release the PR branch BEFORE anything is queued against it. A follow-up
  // spawned below attaches its OWN worktree to `worktreeBranch`, and the CoS
  // evaluation tick preps that task within a second or two — comfortably
  // inside the window this cleanup needs for its own teardown. Removing
  // afterwards lost that race (~0.7s in the reported incident): the
  // follow-up's `git worktree add` failed with "is already used by worktree
  // at …", the task was blocked, and the pull request it existed to land was
  // orphaned. Nothing below this point reads the worktree — the Copilot
  // pre-request above is the last user of that checkout.
  const { removeWorktree } = await import('../worktreeManager.js');
  const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false, ...lockfileDeliverable(originalTask) }).catch(err => {
    emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
    return { cleanupIncomplete: true, warnings: [`Worktree cleanup failed: ${err.message}`] };
  });
  warnings.push(...(result?.warnings || []));

  // The PR itself is already open and stays reported as such; only work that
  // needs the branch FREE is gated on whether the release actually happened.
  // `cleanupIncomplete` means a removal was attempted and failed. A tree merely
  // preserved for uncommitted work (`removed:false` without it) is deliberately
  // not gated: the follow-up adopts that surviving holder rather than racing it
  // (agentWorkspacePrep's adoptWorktreeHoldingBranch), which is the data-safe path.
  await completeReleasedPullRequest(context, prResult, resolvedPrCompletion, reviewerList, leaveOpen, {
    branchHeld: !!result?.cleanupIncomplete,
  });
  return warnings;
}

async function preRequestWorktreeReview({ agentId, worktreePath, warnings }, prResult, runsReviewLoop, reviewerList) {
  const copilotIsFirst = reviewerList[0] === DEFAULT_REVIEWER;
  const nonCopilotReviewers = reviewerList.filter(r => r !== DEFAULT_REVIEWER);
  // Pre-request the native Copilot review ONLY when copilot LEADS the order — it
  // then reviews the freshly-opened PR. When copilot is configured after a CLI
  // reviewer (e.g. [codex, copilot]), pre-requesting now would make Copilot review
  // the stale pre-CLI-fix diff; instead the follow-up agent requests it at copilot's
  // turn, after the earlier reviewer's fixes are pushed. This pre-request is a
  // latency optimization only — the follow-up requests Copilot at its turn
  // regardless, so a failed/absent pre-request is recoverable (no reviewer dropped).
  if (runsReviewLoop && copilotIsFirst) {
    const reviewResult = await requestCopilotReview(worktreePath, prResult.url).catch(err => ({ success: false, error: err.message }));
    if (reviewResult.success && reviewResult.skipped) {
      emitLog('info', `🤖 Skipping Copilot pre-request for ${prResult.url} (non-GitHub forge)`, { agentId, prUrl: prResult.url });
    } else if (reviewResult.success) {
      emitLog('success', `🤖 Requested initial Copilot review on ${prResult.url}`, { agentId, prUrl: prResult.url });
    } else {
      emitLog('warn', `🤖 Copilot pre-request failed for ${prResult.url}: ${reviewResult.error} — follow-up will re-request at its turn`, { agentId, prUrl: prResult.url });
      warnings.push(`Copilot review request failed for ${prResult.url}: ${reviewResult.error}`);
    }
  }
  if (runsReviewLoop && nonCopilotReviewers.length > 0) {
    emitLog('info', `🤖 Follow-up will run CLI reviewers: ${nonCopilotReviewers.join(', ')}`, { agentId, prUrl: prResult.url });
  }
}

async function completeReleasedPullRequest(context, prResult, resolvedPrCompletion, reviewerList, leaveOpen, { branchHeld = false } = {}) {
  const { agentId } = context;
  const runsReviewLoop = resolvedPrCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  if (resolvedPrCompletion === PR_COMPLETIONS.LEAVE_OPEN) {
    emitLog('info', `🤝 Leaving ${prResult.url} open by task completion policy`, { agentId, prUrl: prResult.url });
  } else if (leaveOpen && !runsReviewLoop) {
    emitLog('info', `🤝 Leaving ${prResult.url} open for a human — JIRA-tracked task, no reviewers configured`, { agentId, prUrl: prResult.url });
  } else {
    const queuedDeterministicMerge = await queueWorktreeMerge(context, prResult, resolvedPrCompletion);

    if (!queuedDeterministicMerge && branchHeld) {
      deferFollowUpWhileBranchHeld(context, prResult.url);
    } else if (!queuedDeterministicMerge) {
      await handoffFollowUpAfterRelease(context, prResult.url, {
        prCompletion: resolvedPrCompletion,
        reviewers: runsReviewLoop ? reviewerList : [],
        usernames: runsReviewLoop ? context.usernames : [],
        optionalReviewers: runsReviewLoop ? context.optionalReviewers : [],
        reviewerMaxRounds: runsReviewLoop ? context.reviewerMaxRounds : {},
      });
    }
  }
}

async function queueWorktreeMerge({ agentId, worktreeBranch, originalTask, description }, prResult, resolvedPrCompletion) {
  // A merge-only GitHub PR needs no model while CI is healthy. Hand it to
  // pr-watcher's deterministic tick instead; that tick merges green PRs
  // directly and recreates this exact follow-up only for a failed check or
  // conflict. Non-GitHub forges and unscoped tasks retain the legacy agent
  // path because pr-watcher intentionally speaks gh against managed apps.
  const canQueueDeterministicMerge = resolvedPrCompletion === PR_COMPLETIONS.MERGE_ON_GREEN
    && prResult.cli === 'gh'
    && !!originalTask?.metadata?.app;
  let queuedDeterministicMerge = false;
  if (canQueueDeterministicMerge) {
    const parsedPr = parsePullRequestUrl(prResult.url);
    try {
      const { queuePendingMerge } = await import('../prWatcher.js');
      queuedDeterministicMerge = await queuePendingMerge(originalTask.metadata.app, {
        prUrl: prResult.url,
        prNumber: parsedPr?.number,
        prBranch: worktreeBranch,
        sourceAgentId: agentId,
        sourceTask: {
          id: originalTask?.id || null,
          priority: originalTask?.priority || 'MEDIUM',
          description: originalTask?.description || description || 'CoS automated task',
          metadata: {
            app: originalTask.metadata.app,
            provider: originalTask.metadata.provider,
            providerId: originalTask.metadata.providerId,
            model: originalTask.metadata.model,
            effort: originalTask.metadata.effort,
            executionOptions: originalTask.metadata.executionOptions,
          }
        }
      });
    } catch (err) {
      emitLog('warn', `🤖 Failed to queue deterministic merge for ${prResult.url}: ${err.message}`, { agentId, prUrl: prResult.url });
    }
    if (queuedDeterministicMerge) {
      emitLog('info', `🤖 Queued ${prResult.url} for deterministic merge on the next pr-watcher tick`, { agentId, prUrl: prResult.url });
    }
  }
  return queuedDeterministicMerge;
}

// A healthy handoff owns the branch until it merges (#12247); anything else
// open or unreadable is preserved for recovery.
const preservedPrState = (pr) => (pr?.mergeHandoffQueued === true ? 'pending-merge handoff'
  : pr?.autoMergeEnabled === true ? 'pending GitHub auto-merge' : 'unconfirmed PR recovery');

async function mergeOrPreserveWorktree({ agentId, sourceWorkspace, worktreeBranch, warnings, skipMerge, originalTask }, disposition) {
  // Default: auto-merge on success, just cleanup on failure.
  // Review-loop follow-up agents pass skipMerge: true because gh pr merge already
  // handled the merge upstream — re-merging the worktree branch into the local
  // source workspace would duplicate the squashed commits.
  const shouldMerge = disposition.merge;
  if (skipMerge) {
    const meta = originalTask?.metadata;
    const forkPrNumber = meta?.forkHead && (meta.reviewLoopPRNumber || meta.prRemediationNumber);
    const pr = await import('../prProbe.js').then(({ probePrForBranch, probeChangeRequestState }) =>
      meta?.forkHead
        ? probeChangeRequestState(sourceWorkspace, { number: forkPrNumber, branch: resolveTaskRemoteBranch(meta) })
        : probePrForBranch(sourceWorkspace, worktreeBranch)).catch(() => null);
    if (!pr?.readable || (pr.prState && pr.prState !== 'MERGED')) {
      // Failed/unreadable CI or unpublished commits need recovery, which needs this
      // branch. Only a healthy handoff suppresses the post-cleanup audit.
      emitLog('info', `🌳 Preserving ${preservedPrState(pr)} worktree for ${agentId}`, { agentId, branchName: worktreeBranch });
      return;
    }
  }
  emitLog('info', `🌳 Cleaning up worktree for agent ${agentId} (merge: ${shouldMerge})`, {
    agentId, branchName: worktreeBranch, merge: shouldMerge
  });

  // Cleanup retains branches without merge evidence, including failed runs and
  // successful runs whose PR could not be confirmed. Their retry can resume
  // from the preserved work through resolveResumeBranch below.
  const { removeWorktree } = await import('../worktreeManager.js');
  const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, {
    merge: shouldMerge,
    ...lockfileDeliverable(originalTask),
  }).catch(err => {
    emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
    return { cleanupIncomplete: true, warnings: [`Worktree cleanup failed: ${err.message}`] };
  });
  warnings.push(...(result?.warnings || []));

  // The branch just landed by local merge. If the agent pushed it anyway — an
  // older prompt said `/do:push` under this posture, and the repo's own
  // "commit and push" convention still reaches every agent — origin holds a
  // copy nothing will ever read, which the post-completion audit reports as a
  // leaked remote branch and hands to a recovery agent. Finish the job here,
  // deterministically, instead of paying a model to run one `git push --delete`.
  if (result?.merged) await deleteMergedRemoteCopy(agentId, sourceWorkspace, worktreeBranch);
  return result;
}

// A follow-up attaches its OWN worktree to the PR branch, which `git worktree
// add` refuses while the old checkout still holds it. When cleanup could not
// release the branch, dispatching now just blocks the task and orphans the PR it
// exists to land — so the dispatch is withheld and the state is reported as a
// retryable cleanup warning (the post-cleanup repo-state audit independently
// observes the surviving worktree and files the recovery that retries removal
// and drives the PR). The PR itself is untouched: it stays open/merged as it was.
function deferFollowUpWhileBranchHeld({ agentId, worktreeBranch, worktreePath, warnings }, prUrl) {
  // The failed removal that left the branch held reported itself; this line only records the deferral.
  emitLog('info', `🌳 Deferring follow-up for ${prUrl} — worktree ${agentId} still holds ${worktreeBranch}`, { agentId, prUrl, branchName: worktreeBranch });
  warnings.push(`PR follow-up for ${prUrl} deferred — worktree ${worktreePath || agentId} still holds branch ${worktreeBranch}; retry the worktree cleanup, then re-dispatch the follow-up`);
}

// Call only after removeWorktree settles: the follow-up attaches its own
// checkout to this branch. Both PR creation and failed-agent recovery use this
// one argument builder; their completion/reviewer compatibility defaults differ.
async function handoffFollowUpAfterRelease(context, prUrl, overrides, failureKind = 'created') {
  const { agentId, worktreeBranch, sourceWorkspace, warnings, originalTask,
    prCompletion, reviewers, usernames, optionalReviewers, reviewerMaxRounds,
    reviewStopMode, reviewerModels, reviewerEfforts } = context;
  await spawnReviewLoopFollowUp({
    originalAgentId: agentId, originalTask, prUrl, prBranch: worktreeBranch,
    sourceWorkspace, prCompletion, reviewers, usernames, optionalReviewers,
    reviewerMaxRounds, reviewStopMode, reviewerModels, reviewerEfforts,
    leaveOpen: leavesPrForHuman(originalTask),
    ...overrides,
  }).catch(err => {
    if (failureKind === 'orphaned') {
      emitLog('warn', `🌳 Failed to spawn a follow-up for orphaned ${prUrl}: ${err.message}`, { agentId });
      warnings.push(`Could not queue a follow-up for ${prUrl}: ${err.message}`);
    } else {
      emitLog('warn', `🤖 Failed to spawn PR follow-up for ${prUrl}: ${err.message}`, { agentId, prUrl });
      warnings.push(`PR follow-up spawn failed for ${prUrl}: ${err.message}`);
    }
  });
}

/**
 * Delete origin's copy of a worktree branch that cleanup just merged locally.
 *
 * Cheap on the common path, narrow on the rare one:
 *   - A push from the worktree updates the shared clone's remote-tracking ref,
 *     so `refs/remotes/origin/<branch>` answers "did this agent push?" with one
 *     local rev-parse and no network. Absent ⇒ nothing to do. (A push from some
 *     other clone is invisible here; the repo-state audit still reports it.)
 *   - Merge evidence uses `git.hasBranchMergeEvidence` — the predicate the branch-
 *     reconcile reaper and `removeWorktree` already use — so a copy the agent
 *     amended or rebased after pushing (patch-equivalent, not an ancestor) still
 *     counts as landed, and an unresolvable object fails closed.
 *   - The delete is lease-protected against the SHA this clone last pushed: one
 *     round trip that asserts and deletes atomically, refused as "stale info" if
 *     origin has since moved. Nothing is deleted on stale knowledge.
 * Never adds a warning: a warning is what spawns cleanup's own merge-recovery
 * task, and a copy that could not be deleted is exactly what the audit exists
 * to catch on its own.
 */
async function deleteMergedRemoteCopy(agentId, sourceWorkspace, branchName) {
  const remoteRef = `refs/heads/${branchName}`;
  const tracked = await execGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`], sourceWorkspace, { ignoreExitCode: true })
    .catch(() => null);
  const pushedSha = tracked?.exitCode === 0 ? tracked.stdout.trim() : '';
  if (!pushedSha) return;
  const hasMergeEvidence = await hasBranchMergeEvidence(sourceWorkspace, pushedSha, 'HEAD').catch(() => false);
  if (!hasMergeEvidence) {
    emitLog('warn', `🌳 origin/${branchName} (${pushedSha.slice(0, 7)}) has no established merge evidence in the checkout that received the branch — left in place for the repo-state audit`, { agentId, branchName });
    return;
  }
  const pushed = await execGit(['push', `--force-with-lease=${remoteRef}:${pushedSha}`, 'origin', `:${remoteRef}`], sourceWorkspace, { ignoreExitCode: true })
    .catch(err => ({ exitCode: 1, stderr: err.message }));
  if (pushed.exitCode === 0) {
    emitLog('info', `🌳 ${agentId} pushed ${branchName} but cleanup merged it locally — deleted the remote copy`, { agentId, branchName });
    return;
  }
  const why = String(pushed.stderr || '').trim().split('\n').pop() || `exit ${pushed.exitCode}`;
  emitLog('warn', `🌳 Could not delete origin/${branchName} after merging it locally (${why}) — left for the repo-state audit`, { agentId, branchName });
}

/**
 * The post-cleanup write that RELEASES a failed task's retry hold, shared by every
 * spawn mode (#3368, #3373).
 *
 * A failed agent whose branch — or whole worktree — survived cleanup leaves real
 * work behind (cleanup requires merge evidence; a dirty tree aborts removal
 * outright). Recording where it lives on the TASK is what makes its retry RESUME
 * rather than restart from scratch — the behavior the agent-d2ae0352 incident
 * exposed, where a run reaped 30s after its PR merged was re-dispatched to a fresh
 * agent that began the shipped work over.
 *
 * Call this AFTER `cleanupAgentWorktree` so it reflects what actually survived, and
 * from all three completion paths — the two in-process spawners (`spawnDirectly` in
 * agentCliSpawning.js and the TUI `finish()` in agentTuiSpawning.js, both through
 * `runSpawnerCompletionCleanup`) and `handleAgentCompletion`
 * (agentCompletionCleanup.js, runner mode). Only the runner path used to do it, so a
 * failed direct-CLI/TUI run left a branch full of commits nothing would ever point a
 * retry at.
 *
 * Only for a task that is actually going to RETRY. The failure verdict has already
 * been persisted by `finalizeAgent` at this point, and a retryable failure leaves
 * the task HELD — `in_progress` plus the retry-hold marker (#3373,
 * lib/taskRetryHold.js) — precisely so nothing can dequeue it during the cleanup
 * this call follows. Releasing the hold and writing the pointer is therefore ONE
 * `updateTask`: the task becomes spawnable and pointed in the same write, never
 * spawnable-then-pointed. A `blocked` task that exhausted its budget carries no
 * hold and gets no pointer — dead metadata `updateTask` would strip again on the
 * next terminal write, and that a later `reviveBlockedTask` would resurrect as a
 * live pointer to a branch nobody vetted.
 *
 * The no-hold fallback (a task we read as plain `pending`) still writes the pointer
 * alone: that is the pre-#3373 shape, and it is also what a task the orphan sweep
 * already recovered mid-cleanup looks like. Anything else we read — `blocked`,
 * `in_progress` under someone else's hold or none at all (the retry already
 * spawned), a failed read, a task deleted mid-run — is not evidence of a retry we
 * own, so we write nothing.
 *
 * `agentMetadata` is optional: pass it when the caller already holds the agent
 * record (the runner path does), omit it and this reads the record itself —
 * `getAgentRecord`, not `getAgent`, so it doesn't read and line-split the run's
 * whole output.txt for three metadata fields. `undefined` means "not supplied" —
 * a caller that genuinely has no metadata still gets the no-op it deserves, since
 * `resolveTaskResumePatch` bails on a non-worktree run.
 *
 * @param {{agentId: string, task: object, success: boolean, agentMetadata?: object}} params
 * @returns {Promise<object>} the metadata patch that was written (empty when nothing was)
 */
async function loadAgentMetadata(agentId, agentMetadata, { tolerateFailure = true } = {}) {
  if (agentMetadata !== undefined) return agentMetadata;
  const record = tolerateFailure
    ? await getAgentRecord(agentId).catch(() => null)
    : await getAgentRecord(agentId);
  return record?.metadata;
}

async function releaseBlockedDeliveryHold({ agentId, task, persisted, agentMetadata, recoveryOwner }) {
  if (persisted.metadata.deliveryDecisionAgentId !== agentId) return {};
  const metadata = await loadAgentMetadata(agentId, agentMetadata, { tolerateFailure: false });
  const isRuntimeVerification = persisted.metadata.blockedCategory === 'runtime-verification';
  const patch = isRuntimeVerification
    ? await runtimeResumePatch({ task: persisted, agentId, agentMetadata: metadata })
    : await resolveTaskResumePatch({ task, agentId, agentMetadata: metadata });
  const result = await updateTask(task.id, {
    metadata: { ...patch, ...(isRuntimeVerification ? { runtimeVerificationReadyAgentId: agentId } : {}) },
  }, task.taskType || persisted.taskType || 'user', {
    expectedStatus: 'blocked',
    expectedMetadata: {
      blockedCategory: persisted.metadata.blockedCategory,
      blockedAt: persisted.metadata.blockedAt,
      deliveryDecisionAgentId: agentId,
    },
    ...(recoveryOwner ? { recoveryOwner, expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata } } : {}),
  });
  return result?.error || result?.statusChanged ? {} : patch;
}

async function releaseLegacyDeepAuditHold({ agentId, task, persisted, agentMetadata }) {
  if (persisted.status !== 'in_progress' || !isRetryHoldOwner(persisted.metadata, agentId)) return {};
  const metadata = await loadAgentMetadata(agentId, agentMetadata);
  const patch = await resolveTaskResumePatch({ task, agentId, agentMetadata: metadata });
  const result = await updateTask(task.id, { status: 'blocked', metadata: {
    ...patch, ...clearedRetryHoldMetadata(), blockedCategory: 'deep-audit-partial',
    blockedReason: 'Deep audit checkpoint; resume explicitly', blockedAt: new Date().toISOString(),
  } }, task.taskType || persisted.taskType || 'user', {
    expectedStatus: 'in_progress', expectedMetadata: { retryPendingCleanup: agentId },
  });
  return result?.error || result?.statusChanged ? {} : patch;
}

// Cleanup may already have handed this exact deliverable to a durable
// review/merge coordinator. Releasing a second implementation retry races
// that coordinator for the same branch and spends another task budget.
async function handoffExistingDeliveryFollowUp({ agentId, task, persisted, metadata }) {
  const queues = await getAllTasks();
  const followUps = (queues.cos?.tasks || []).filter(candidate => candidate.id !== persisted.id
    && isTruthyMeta(candidate.metadata?.reviewLoopFollowUp)
    && candidate.metadata.sourceTaskId === persisted.id && candidate.metadata.sourceAgentId === agentId
    && typeof metadata?.worktreeBranch === 'string' && !!parsePullRequestUrl(candidate.metadata.reviewLoopPRUrl)
    && candidate.metadata.reviewLoopPRBranch === metadata.worktreeBranch
    && candidate.metadata.app === persisted.metadata?.app && !leavesPrForHuman(candidate)
    && ['pending', 'approved', 'in_progress', 'blocked', 'completed'].includes(candidate.status));
  if (followUps.length > 1) throw new Error('Multiple delivery follow-up owners require reconciliation');
  if (followUps.length !== 1) return false;
  const current = await getAgentRecord(agentId);
  if (current?.status !== 'completed' || current.taskId !== persisted.id
    || current.result?.executionSuccess !== true || current.result?.validationPassed === false) return true;
  const recorded = await recordRepoStateVerification(agentId, { status: 'pending', reason: 'existing-delivery-follow-up',
    followUpTaskId: followUps[0].id, checkedAt: new Date().toISOString() });
  if (recorded !== true) throw new Error('Delivery follow-up receipt could not be recorded');
  await updateAgent(agentId, { result: { ...current.result, cleanupPending: true } });
  const result = await updateTask(persisted.id, { status: 'in_progress', metadata: {
    ...clearedRetryHoldMetadata(), deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agentId,
    deliveryFollowUpTaskId: followUps[0].id,
  } }, task.taskType || persisted.taskType || 'user', { expectedStatus: 'in_progress',
    expectedTask: { description: persisted.description, priority: persisted.priority, metadata: persisted.metadata } });
  if (result?.error) throw new Error(result.error);
  return true;
}

export async function releaseRetryHold({ agentId, task, success, agentMetadata, recoveryOwner }) {
  if (!agentId || !task?.id) return {};
  if (success && !isLegacyDeepAudit(task.metadata)) return {};

  const persisted = await getTaskById(task.id).catch(err => {
    emitLog('warn', `Skipping resume pointer for task ${task.id} — status unreadable: ${err.message}`, { taskId: task.id, agentId });
    return null;
  });
  if (!persisted) return {};

  if (persisted.status === 'blocked' && DELIVERY_RECOVERY_BLOCKED_CATEGORIES.has(persisted.metadata?.blockedCategory)) {
    return releaseBlockedDeliveryHold({ agentId, task, persisted, agentMetadata, recoveryOwner });
  }

  if (isLegacyDeepAudit(task.metadata)) {
    return releaseLegacyDeepAuditHold({ agentId, task, persisted, agentMetadata });
  }

  // Release only OUR hold, and only while the task is still held `in_progress`.
  // Both halves matter: a slow cleanup from a previous attempt must not clear the
  // hold the CURRENT attempt just armed (it would make the task spawnable while
  // that attempt's cleanup is still running — the very race this exists to close),
  // and a task that reached `blocked`/`completed` carrying a stale marker must
  // never be flipped back to `pending` by a late cleanup.
  const held = isRetryHoldOwner(persisted.metadata, agentId) && persisted.status === 'in_progress';
  // A record with no `status` at all is a legacy shape that predates the field;
  // those are pending.
  if (!held && (persisted.status ?? 'pending') !== 'pending') return {};

  const metadata = await loadAgentMetadata(agentId, agentMetadata);
  if (!held) return await recordTaskResumePointer({ task, agentId, agentMetadata: metadata });

  if (await handoffExistingDeliveryFollowUp({ agentId, task, persisted, metadata })) return {};

  // Fails open to "start clean" for the same reason `handleOrphanedTask` does:
  // requeueing the task matters far more than resuming it, and a throw here would
  // leave it held until the orphan sweep.
  const patch = await resolveTaskResumePatch({ task, agentId, agentMetadata: metadata }).catch(err => {
    emitLog('warn', `Resume pointer for task ${task.id} could not be resolved: ${err.message}`, { taskId: task.id, agentId });
    return {};
  });
  const taskType = task.taskType || persisted.taskType || 'user';
  const result = await updateTask(task.id, {
    status: 'pending',
    metadata: { ...patch, ...clearedRetryHoldMetadata() }
  }, taskType, {
    expectedStatus: 'in_progress', expectedMetadata: { retryPendingCleanup: persisted.metadata.retryPendingCleanup },
  }).catch(err => {
    emitLog('warn', `Failed to release retry hold on task ${task.id}: ${err.message}`, { taskId: task.id, agentId });
    return { error: err.message };
  });
  if (result?.statusChanged) return {};
  if (result?.error) {
    // The hold is still on disk, so the orphan sweep finishes the transition —
    // the task is delayed, never stranded.
    emitLog('warn', `⏳ Task ${task.id} still held after a failed release — the orphan sweep will requeue it`, { taskId: task.id, agentId });
    return {};
  }
  const targetBranch = resolveTaskTargetBranch(patch);
  emitLog('info', targetBranch
    ? `🔁 Task ${task.id} requeued pointing at ${targetBranch}`
    : `🔓 Task ${task.id} requeued for retry`, { taskId: task.id, agentId, branchName: targetBranch });
  return patch;
}

/** Retain warning recovery on the original completion receipt. No new agent,
 * retry budget or personal obligation is created by a cleanup warning. */
export async function spawnMergeRecoveryTask(cleanupWarnings, agentId, task, appName, sourceWorkspace) {
  if (!cleanupWarnings?.length || !agentId || !sourceWorkspace) return null;
  // Draft/review-only delivery remains with its explicit owner. A warning
  // cannot grant the completion sweep authority to retire that checkout.
  if (resolvePrCompletion(task?.metadata) === PR_COMPLETIONS.LEAVE_OPEN) return null;
  const agent = await getAgentRecord(agentId);
  const branch = agent?.metadata?.worktreeBranch || agent?.metadata?.claimBranch
    || cleanupWarnings.map(warning => warning.match(/(?:Auto-merge failed|PR creation failed) for branch (\S+?)(?=:|\s|$)/)?.[1]).find(Boolean);
  if (branch) {
    const worktreePath = agent?.metadata?.isWorktree
      ? (agent.metadata.workspacePath || join(PATHS.worktrees, agentId))
      : (agent?.metadata?.worktreePath || null);
    const recorded = await recordCleanupOutcome(agentId, { status: 'pending', reason: 'cleanup-warning-pending', branch,
      path: worktreePath, warnings: cleanupWarnings, sourceWorkspace, taskId: task?.id || null });
    if (!recorded) throw new Error('cleanup-warning-receipt-unavailable');
  }
  const pending = await recordRepoStateVerification(agentId, { status: 'pending', reasons: ['cleanup-warning-pending'] });
  if (!pending) throw new Error('cleanup-warning-replay-unavailable');
  emitLog('info', 'Cleanup warning retained for deterministic completion recovery', { agentId, appName });
  return null;
}
