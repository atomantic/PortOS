import { isLegacyDeepAudit } from '../lib/auditWorkflow.js';
/**
 * Agent Worktree Cleanup
 *
 * Post-completion worktree handling for agents: merge-or-PR the worktree
 * branch, drive the multi-reviewer review-loop follow-up, and retain
 * completion recovery when a merge or PR creation fails. Extracted from
 * agentLifecycle.js as a self-contained leaf so the completion-cleanup
 * orchestrator (agentCompletionCleanup.js) can import it without a circular
 * dependency back into agentLifecycle.js. Consumers import these functions from
 * here directly — the agentLifecycle.js pass-through re-exports were retired
 * with the subAgentSpawner barrel (#3450).
 */

import { existsSync } from 'fs';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { join } from 'path';
import { emitLog } from './cosEvents.js';
import { addTask, updateTask } from './cosTaskStore.js';
import { forceSpawnTask } from './cos.js';
import { getAgents } from './cosAgentLifecycle.js';
import * as git from './git.js';
import { resolveTaskHookType } from './taskTypeHooks.js';
import { removeWorktree, classifyWorktreeDirt, listWorktrees } from './worktreeManager.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';
import { claimContinuationPointer } from '../lib/claimContinuation.js';
import { isTruthyMeta } from './agentState.js';
import { PATHS } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { isRetryHoldOwner, clearedRetryHoldMetadata } from '../lib/taskRetryHold.js';
import { resolveTaskTargetBranch, resolveTaskRemoteBranch, shouldStripTaskTargetBranch } from '../lib/taskTargetBranch.js';
import { ServerError } from '../lib/errorHandler.js';
import { detectForgeCli } from '../lib/gitForge.js';
import { normalizeForkHead } from '../lib/forkHead.js';
import { PR_COMPLETIONS, resolvePrCompletion, PR_COMPLETION_VALUES, PR_CREATION, PR_MISSING_CATEGORY, leavesPrForHuman, prClaimWasVerified, prHeldForOperator } from '../lib/prDisposition.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, MODEL_SELECTABLE_REVIEWERS, EFFORT_SELECTABLE_REVIEWERS, isProviderReviewer, normalizeReviewers, normalizeReviewUsernames, normalizeOptionalReviewers, normalizeReviewerMaxRounds, prioritizeToolFreeReviewers } from '../lib/reviewerConfig.js';

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
 * (`all`/`on-findings`/`on-clean`) and `reviewerApplies` are threaded into the follow-up's
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
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const agentState = await getAgentRecord(agentId).catch(() => null);
  if (publicationHolds.has(agentId) || ['running', 'blocked'].includes(agentState?.metadata?.publicationValidation?.status)) return;
  await verifyAgentRepoState({
    agentId,
    task: originalTask,
    agentState,
    success,
    prExpected: isTruthyMeta(originalTask?.metadata?.openPR),
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
  const { getAgent } = await import('./cosAgentLifecycle.js');
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
    };
  }
  const { sourceWorkspace, worktreeBranch } = metadata;
  if (!sourceWorkspace || !worktreeBranch) {
    return { isWorktree: false, claimBranches, sourceWorkspace: sourceWorkspace || metadata?.workspacePath || null };
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

async function cleanupClaimBranchWorktrees(agentId, { sourceWorkspace, claimBranches }) {
  if (!sourceWorkspace || !Array.isArray(claimBranches) || !claimBranches.length) return [];
  const worktrees = await listWorktrees(sourceWorkspace).catch(() => []);
  const defaultBranch = await git.getDefaultBranch(sourceWorkspace).catch(() => 'main');
  const { probePrForBranch } = await import('./prProbe.js');
  for (const branch of claimBranches) {
    const holder = worktrees.find(wt => (wt.branch || '').replace(/^refs\/heads\//, '') === branch && wt.path !== sourceWorkspace) || null;
    const probe = await probePrForBranch(sourceWorkspace, branch).catch(() => null);
    const prMerged = probe?.prState === 'MERGED';
    let cleanEmptyBranch = false;
    if (!prMerged) {
      const commitsAhead = await git.getCommitsAhead(sourceWorkspace, defaultBranch, branch).catch(() => null);
      if (commitsAhead === 0) {
        if (holder?.path && existsSync(holder.path)) {
          const status = await execGit(['status', '--porcelain'], holder.path, { ignoreExitCode: true }).catch(() => null);
          cleanEmptyBranch = status?.exitCode === 0 && !status.stdout.trim();
        } else {
          cleanEmptyBranch = true;
        }
      }
    }
    if (!prMerged && !cleanEmptyBranch) continue;
    if (holder?.path) {
      await execGit(['worktree', 'unlock', holder.path], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
      await removeWorktree(sourceWorkspace, holder.path, { deleteBranch: true, force: true }).catch(() => null);
    }
    await execGit(['branch', '-D', branch], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
    if (prMerged) {
      await execGit(['push', 'origin', '--delete', branch], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
    }
    emitLog('info', `🌳 Cleaned up claim branch ${branch} for ${agentId} (${prMerged ? 'PR merged' : 'empty clean branch'})`, {
      agentId, branchName: branch,
    });
  }
  return [];
}

async function probeWorktreePr(context, success) {
  if (!context.isWorktree || context.discardWorktree || context.prCreation !== PR_CREATION.IF_MISSING) return null;
  const { worktreePath, worktreeBranch, agentOutput } = context;
  if (success) {
    const { verifyPrClaim } = await import('./agentFinalization.js');
    // `agentOutput` (the run's output buffer) rides along so the probe can
    // recognize the parallel-claim stand-down the same way finalize did —
    // without it, cleanup would re-ask the forge, see "no PR", and open a
    // DUPLICATE of the change request the summary says already landed.
    const { extractFinalSummary } = await import('./agentSummaryExtraction.js');
    const agentSummary = extractFinalSummary(agentOutput);
    return verifyPrClaim({ task: context.originalTask, workspacePath: worktreePath, success: true, prExpected: true, agentSummary })
      .catch(err => ({ ok: false, category: 'forge-unreachable', message: err.message }));
  }
  const { findPullRequestForBranch } = await import('./github.js');
  const forge = await git.resolveForgeForRepo(worktreePath).catch(() => null);
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
    const { getTaskById } = await import('./cosTaskStore.js');
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
    const { getTaskById } = await import('./cosTaskStore.js');
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

function cleanupOptions({ prCreation = PR_CREATION.NEVER, prCompletion = null, requestCopilotReview: legacyRequestCopilotReview = false, reviewers, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, reviewerModels = null, reviewerEfforts = null, skipMerge = false, description = null, agentOutput = null, originalTask = null } = {}) {
  return { prCreation, prCompletion, legacyRequestCopilotReview, reviewers, usernames,
    optionalReviewers, reviewerMaxRounds, reviewStopMode, reviewerApplies,
    reviewerModels, reviewerEfforts, skipMerge, description, agentOutput, originalTask };
}

// A lockfile-only diff is a legitimate deliverable for dependency-updates only.
export const lockfileDeliverable = (task) => (resolveTaskHookType(task) === 'dependency-updates' ? { preserveLockfiles: true } : {});

async function discardAgentWorktree({ agentId, sourceWorkspace, worktreeBranch }) {
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
    const { updateAgent } = await import('./cosAgentLifecycle.js');
    try {
      publicationHolds.set(agentId, { status: 'running' });
      await updateAgent(agentId, { metadata: { publicationValidation: { status: 'running', startedAt: new Date().toISOString() } } });
      const { validatePublication } = await import('./publicationValidation.js');
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
    git.push(worktreePath, worktreeBranch).then(() => true).catch(err => {
      emitLog('warn', `🌳 Failed to push worktree branch ${worktreeBranch}: ${err.message}`, { agentId });
      return false;
    }),
    git.getRepoBranches(sourceWorkspace).catch(() => ({ baseBranch: null, devBranch: null }))
  ]);

  if (!pushResult) {
    warnings.push(`Push failed for branch ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`);
    emitLog('warn', `🌳 Push failed for ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`, { agentId, branchName: worktreeBranch });
    return warnings;
  }
  let targetBranch = branchInfo.baseBranch;
  if (!targetBranch) {
    targetBranch = await git.getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null) || 'main';
  }
  const prTitle = await git.suggestPRTitle(worktreePath, targetBranch, worktreeBranch, description);

  const prBody = await git.generatePRDescription(worktreePath, targetBranch, worktreeBranch, agentOutput, context.securityScan, context.securityScanControl);

  const prResult = await git.createPR(worktreePath, {
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
    const { verifyPrClaim } = await import('./agentFinalization.js');
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
    await git.deleteBranch(sourceWorkspace, worktreeBranch, { remote: true }).catch(err => {
      emitLog('warn', `🌳 Remote branch delete failed for ${worktreeBranch}: ${err.message}`, { agentId });
      warnings.push(`Remote branch delete failed for ${worktreeBranch}: ${err.message}`);
    });
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
  const { recordBranchCompletionPolicy } = await import('./branchCompletionPolicy.js');
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
    const reviewResult = await git.requestCopilotReview(worktreePath, prResult.url).catch(err => ({ success: false, error: err.message }));
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
    const parsedPr = git.parsePullRequestUrl(prResult.url);
    try {
      const { queuePendingMerge } = await import('./prWatcher.js');
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
    const pr = await import('./prProbe.js').then(({ probePrForBranch, probeChangeRequestState }) =>
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
    reviewStopMode, reviewerApplies, reviewerModels, reviewerEfforts } = context;
  await spawnReviewLoopFollowUp({
    originalAgentId: agentId, originalTask, prUrl, prBranch: worktreeBranch,
    sourceWorkspace, prCompletion, reviewers, usernames, optionalReviewers,
    reviewerMaxRounds, reviewStopMode, reviewerApplies, reviewerModels, reviewerEfforts,
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
  const hasMergeEvidence = await git.hasBranchMergeEvidence(sourceWorkspace, pushedSha, 'HEAD').catch(() => false);
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
 * What, if anything, should a retry of this task pick up from the run that just
 * died? Called after cleanup has decided what to preserve, so the answer reflects
 * what's actually on disk rather than what we hoped.
 *
 * Two shapes of leftover work, in priority order:
 *
 *   1. **Adopt the worktree** — `{ branchName, worktreePath }`. The dead agent's
 *      own worktree survived cleanup (a dirty tree aborts removal) and is still on
 *      its branch. This is the shape a server restart leaves behind: the run is
 *      killed mid-edit, so its work is UNCOMMITTED and no branch pointer can carry
 *      it. The retry moves that tree to its own directory (see `adoptWorktree`).
 *   2. **Attach the branch** — `{ branchName, worktreePath: null }`. The worktree
 *      is gone but the branch survived with unmerged commits, so a fresh worktree
 *      attaches to it via `createWorktree`'s `existingBranch` path.
 *
 * Returns null when there is nothing to resume — no branch, no leftover work, or
 * a branch whose commits already landed. A null answer means "start clean", the
 * correct behavior for an agent that died before producing anything.
 *
 * Deliberately checks the LOCAL branch: `removeWorktree` preserves it in place,
 * and `createWorktree`'s `existingBranch` path prefers a local copy before
 * falling back to `origin/<branch>`, so a local-only branch resumes fine.
 *
 * @param {string} sourceWorkspace - the parent git repository
 * @param {string} branchName - the dead agent's worktree branch
 * @param {string} [worktreePath] - the dead agent's worktree directory, the
 *   adoption candidate. Omit to consider only the branch-attach shape.
 * @returns {Promise<{branchName: string, worktreePath: string|null}|null>}
 */
export async function resolveResumePointer(sourceWorkspace, branchName, worktreePath = null, { preserveLockfiles = false } = {}) {
  if (!sourceWorkspace || !branchName) return null;

  const survivingTree = !!(worktreePath && existsSync(worktreePath));
  const target = await git.getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
  // Same predicate `removeWorktree` used to decide whether to KEEP this branch, so
  // the two can't disagree and orphan it. `hasBranchMergeEvidence` (not a rev-list
  // count) because a rebase/squash-merged branch has new SHAs and would otherwise
  // read as resumable — pointing a retry at already-landed work. Note the polarity
  // flips only for a rejected call: resume starts clean on rejection, while the
  // predicate's internal probe failures still return false. The existence checks
  // below keep that negative evidence result from reviving an absent branch.
  const hasMergeEvidence = await git.hasBranchMergeEvidence(sourceWorkspace, branchName, target).catch(() => true);
  // Nothing survived and nothing is unmerged — the common "run finished, branch
  // landed, tree already reaped" shape. Bail before spending any more git calls.
  if (hasMergeEvidence && !survivingTree) return null;

  // How many commits the branch holds that the default branch doesn't. Only ever
  // consulted on one of the two mutually exclusive paths below, so it costs a
  // single call per resolution.
  const commitsAhead = async () =>
    (await git.getBranchComparison(sourceWorkspace, target, branchName).catch(() => null))?.ahead || 0;

  // 1. Adopt the surviving tree — but only if it is actually on the branch we're
  //    resuming; a half-cleaned or repurposed directory must not be handed over.
  if (survivingTree && await git.getBranch(worktreePath).catch(() => null) === branchName) {
    if (!hasMergeEvidence) {
      emitLog('info', `🌳 Worktree ${worktreePath} survived on ${branchName} without established merge evidence — a retry can adopt it`, { branchName, worktreePath });
      return { branchName, worktreePath };
    }
    // A merged branch reads that way for two very different reasons. Commits that
    // already LANDED (ahead > 0) must never be resumed onto — that's the
    // agent-d2ae0352 incident. A branch that never committed at all (ahead === 0)
    // has nothing to duplicate, so an uncommitted tree on top of it is safe to
    // adopt — and that is exactly the restart case this function exists for:
    // killed mid-edit, zero commits, hours of uncommitted work.
    if (await commitsAhead() > 0) return null;
    // Same dirt classifier `removeWorktree` uses, so "worth preserving" and "worth
    // resuming" can't disagree: lockfile churn an agent never meant to commit is
    // not work, and a tree holding only that should start clean.
    const porcelain = await git.getStatusPorcelain(worktreePath).catch(() => '');
    if (!classifyWorktreeDirt(porcelain, { preserveLockfiles }).hasRealChanges) return null;
    emitLog('info', `🌳 Worktree ${worktreePath} survived on ${branchName} — a retry can adopt it and keep its uncommitted work`, { branchName, worktreePath });
    return { branchName, worktreePath };
  }

  if (hasMergeEvidence) return null;

  // 2. Attach a fresh worktree to the branch. Git allows a branch to be checked out
  //    in only ONE worktree, so if a worktree is STILL on this branch, `git worktree
  //    add <path> <branch>` fails with "already checked out" and the retry can't
  //    spawn at all — worse than restarting clean. The adoption path above already
  //    handled the dead agent's OWN worktree; anything else holding the branch is
  //    not ours to move.
  const claimed = await git.getWorktreeBranches(sourceWorkspace).catch(() => null);
  if (claimed?.has(branchName)) {
    emitLog('info', `🌳 Branch ${branchName} is still checked out in a preserved worktree — a retry can't attach to it, so it will start clean`, { branchName });
    return null;
  }
  // Confirm the branch actually exists and holds commits — `hasBranchMergeEvidence`
  // returns false for an absent branch, which would hand back a branch name no
  // worktree can attach to.
  return await commitsAhead() > 0 ? { branchName, worktreePath: null } : null;
}

/**
 * The task-metadata patch that points a retry of `task` at what the run that just
 * died left behind — or clears a spent pointer, or does nothing. Resolves only;
 * `recordTaskResumePointer` persists it, `handleOrphanedTask` folds it into its own
 * retry write. Three outcomes, and the difference between the last two matters:
 *   - a **set** patch — there is leftover work; point the retry at it
 *   - a **clear** patch — this task WAS resuming, we looked, and there is nothing
 *     left (the branch merged or vanished); drop the pointer so the next attempt
 *     doesn't attach to it
 *   - an **empty** patch — nothing to say; leave whatever the task already carries
 *
 * Every path that retires a dead run funnels through here so the "can this be
 * resumed?" question has one answer:
 *   - `handleAgentCompletion` (agentCompletionCleanup.js) — the agent failed and
 *     its completion hook ran normally.
 *   - `handleOrphanedTask` (agentManagement.js) — the agent's process vanished
 *     (server restart / crash), so no completion hook ever ran. That path is why
 *     this is shared: a restart-killed run was requeued with no pointer at all,
 *     and its replacement redid work that was already sitting on disk.
 *
 * @param {{task: object, agentId: string, agentMetadata: object}} params
 * @returns {Promise<object>} metadata patch to merge into an `updateTask` call
 */
/**
 * A claim-flow relaunch continues the `claim-*` worktree the paused run already
 * cut for its pinned target. Resolved before the CoS-worktree bail: claim agents
 * record `isWorktree: false` because PortOS did not provision the directory, and
 * that bail is what used to requeue the relaunch onto a clean checkout.
 *
 * Fails closed (null → the caller keeps the ordinary "start clean" answer) when
 * the agent list cannot be read. An empty list would look like "nobody is in
 * that tree."
 */
async function resolveClaimContinuationPatch({ task, agentId, agentMetadata }) {
  const source = agentMetadata?.sourceWorkspace || agentMetadata?.workspacePath;
  if (!source) return null;
  const agents = await getAgents().catch(() => null);
  if (!agents) return null;
  const worktrees = await listWorktrees(source).catch(() => []);
  const pointer = claimContinuationPointer({
    task, agentId, worktrees, agents, worktreesRoot: PATHS.worktrees, sourceWorkspace: source,
  });
  if (!pointer) return null;
  emitLog('info', `🔁 Task ${task.id} will resume in the claim worktree ${pointer.resumeWorktreePath} (${pointer.existingBranch}) instead of starting clean`, {
    taskId: task.id, agentId, branchName: pointer.existingBranch, worktreePath: pointer.resumeWorktreePath,
  });
  return pointer;
}

export async function resolveTaskResumePatch({ task, agentId, agentMetadata }) {
  if (!task?.id || !agentId) return {};
  if (isTruthyMeta(task.metadata?.discardWorktree)) return {};
  const claimContinuation = await resolveClaimContinuationPatch({ task, agentId, agentMetadata });
  if (claimContinuation) return claimContinuation;
  // Persistent feature-agent worktrees are never torn down, and throwaway
  // reasoning worktrees are deliberately discarded — neither leaves work to resume.
  // These runs are NOT evaluated at all, which is why they return the empty patch
  // rather than the clear: a task already resuming whose retry couldn't get a
  // worktree (see agentWorkspacePrep's degrade path) must KEEP its pointer, since
  // the tree it names is still sitting there for the attempt after this one.
  if (!agentMetadata?.isWorktree || agentMetadata?.isPersistentWorktree) return {};

  // The agent's own recorded path is authoritative; the `<worktrees>/<agentId>`
  // convention is the fallback for a record written before it was stamped (same
  // idiom cleanupAgentWorktree uses for the PR push).
  const worktreePath = agentMetadata.workspacePath || join(PATHS.worktrees, agentId);
  const pointer = await resolveResumePointer(agentMetadata.sourceWorkspace, agentMetadata.worktreeBranch, worktreePath, lockfileDeliverable(task))
    .catch(err => {
      emitLog('warn', `Failed to resolve resume pointer for ${agentId}: ${err.message}`, { agentId });
      return null;
    });

  if (pointer) {
    emitLog('info', `🔁 Task ${task.id} will resume ${pointer.worktreePath ? `in the worktree ${agentId} left behind` : `from ${pointer.branchName}`} instead of restarting`, {
      taskId: task.id, agentId, branchName: pointer.branchName, worktreePath: pointer.worktreePath
    });
  }
  return resumePointerMetadata(pointer, agentId, task);
}

/**
 * The task-metadata patch that makes a retry resume (or stop resuming).
 *
 * `existingBranch` is the retry-owned target that `agentWorkspacePrep` resolves
 * before attaching a worktree, and `resumeWorktreePath` is honored there too, so
 * resuming needs no new spawn plumbing. `resumedFromAgentId` records whose run is
 * being continued — it drives the prompt's resume banner and is the marker that
 * distinguishes a resume from a review-loop follow-up (see `isPrBranchWorktree`
 * in agentPromptBuilder.js).
 *
 * With no pointer, a previously-stamped resume is CLEARED: its branch may since
 * have been merged or deleted, and leaving the pointer would attach the next
 * attempt to landed work. Keyed on `resumedFromAgentId` so it only ever clears a
 * pointer this mechanism wrote. Review-loop follow-ups keep their canonical target
 * in `reviewLoopPRBranch`, so clearing a legacy duplicate cannot strand the PR.
 *
 * @param {{branchName: string, worktreePath: string|null}|null} pointer
 * @param {string} agentId - the run being resumed from
 * @param {object} task - the task being retried (read for a prior pointer)
 * @returns {object} metadata patch to merge into an `updateTask` call
 */
export function resumePointerMetadata(pointer, agentId, task) {
  if (pointer) {
    return {
      existingBranch: pointer.branchName,
      resumedFromAgentId: agentId,
      resumeWorktreePath: pointer.worktreePath
    };
  }
  if (!shouldStripTaskTargetBranch(task?.metadata)) return {};
  // `undefined`, not `null`: `updateTask` DELETES undefined keys from the merged
  // metadata, while a null survives the merge and TASKS.md serializes it as the
  // literal string `"null"` — which reads back as a truthy `existingBranch` and
  // sends the next attempt looking for a branch named "null". The keys are still
  // present on the returned patch, so callers can tell a clear from a no-op.
  return {
    existingBranch: undefined,
    resumedFromAgentId: undefined,
    resumeWorktreePath: undefined,
    claimResumeInPlace: undefined,
  };
}

/**
 * Resolve AND persist the resume patch. For callers that aren't already writing the
 * task; `handleOrphanedTask` folds the patch into its own retry write instead, so
 * the pointer can't land after the status flip that makes the task spawnable.
 *
 * @param {{task: object, agentId: string, agentMetadata: object}} params
 * @returns {Promise<object>} the patch that was written (empty when nothing was)
 */
export async function recordTaskResumePointer({ task, agentId, agentMetadata }) {
  const metadata = await resolveTaskResumePatch({ task, agentId, agentMetadata });
  if (Object.keys(metadata).length === 0) return metadata;

  await updateTask(task.id, { metadata }, task.taskType || 'user').catch(err => {
    emitLog('warn', `Failed to record resume pointer for task ${task.id}: ${err.message}`, { taskId: task.id, agentId });
  });
  if (!resolveTaskTargetBranch(metadata)) {
    emitLog('info', `🧹 Cleared spent resume pointer on task ${task.id} — nothing left to resume`, { taskId: task.id, agentId });
  }
  return metadata;
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
export async function releaseRetryHold({ agentId, task, success, agentMetadata, recoveryOwner }) {
  if (!agentId || !task?.id) return {};
  if (success && !isLegacyDeepAudit(task.metadata)) return {};

  const { getTaskById } = await import('./cosTaskStore.js');
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const persisted = await getTaskById(task.id).catch(err => {
    emitLog('warn', `Skipping resume pointer for task ${task.id} — status unreadable: ${err.message}`, { taskId: task.id, agentId });
    return null;
  });
  if (!persisted) return {};

  if (persisted.status === 'blocked' && ['task-approval', 'task-recovery-exhausted', 'runtime-verification'].includes(persisted.metadata?.blockedCategory)) {
    if (persisted.metadata.deliveryDecisionAgentId !== agentId) return {};
    const metadata = agentMetadata === undefined ? (await getAgentRecord(agentId))?.metadata : agentMetadata;
    const patch = persisted.metadata.blockedCategory === 'runtime-verification'
      ? await runtimeResumePatch({ task: persisted, agentId, agentMetadata: metadata })
      : await resolveTaskResumePatch({ task, agentId, agentMetadata: metadata });
    const result = await updateTask(task.id, { metadata: { ...patch,
      ...(persisted.metadata.blockedCategory === 'runtime-verification' ? { runtimeVerificationReadyAgentId: agentId } : {}) } }, task.taskType || persisted.taskType || 'user', {
      expectedStatus: 'blocked', expectedMetadata: { blockedCategory: persisted.metadata.blockedCategory, blockedAt: persisted.metadata.blockedAt, deliveryDecisionAgentId: agentId },
      ...(recoveryOwner ? { recoveryOwner, expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata } } : {}),
    });
    return result?.error || result?.statusChanged ? {} : patch;
  }

  if (isLegacyDeepAudit(task.metadata)) {
    if (persisted.status !== 'in_progress' || !isRetryHoldOwner(persisted.metadata, agentId)) return {};
    const metadata = agentMetadata === undefined
      ? (await getAgentRecord(agentId).catch(() => null))?.metadata : agentMetadata;
    const patch = await resolveTaskResumePatch({ task, agentId, agentMetadata: metadata });
    const result = await updateTask(task.id, { status: 'blocked', metadata: {
      ...patch, ...clearedRetryHoldMetadata(), blockedCategory: 'deep-audit-partial',
      blockedReason: 'Deep audit checkpoint; resume explicitly', blockedAt: new Date().toISOString(),
    } }, task.taskType || persisted.taskType || 'user', {
      expectedStatus: 'in_progress', expectedMetadata: { retryPendingCleanup: agentId },
    });
    return result?.error || result?.statusChanged ? {} : patch;
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

  const metadata = agentMetadata === undefined
    ? (await getAgentRecord(agentId).catch(() => null))?.metadata
    : agentMetadata;

  if (!held) return await recordTaskResumePointer({ task, agentId, agentMetadata: metadata });

  // Cleanup may already have handed this exact deliverable to a durable
  // review/merge coordinator. Releasing a second implementation retry races
  // that coordinator for the same branch and spends another task budget.
  const { getAllTasks } = await import('./cosTaskStore.js');
  const queues = await getAllTasks();
  const followUps = (queues.cos?.tasks || []).filter(candidate => candidate.id !== persisted.id
    && isTruthyMeta(candidate.metadata?.reviewLoopFollowUp)
    && candidate.metadata.sourceTaskId === persisted.id && candidate.metadata.sourceAgentId === agentId
    && typeof metadata?.worktreeBranch === 'string' && !!git.parsePullRequestUrl(candidate.metadata.reviewLoopPRUrl)
    && candidate.metadata.reviewLoopPRBranch === metadata.worktreeBranch
    && candidate.metadata.app === persisted.metadata?.app && !leavesPrForHuman(candidate)
    && ['pending', 'approved', 'in_progress', 'blocked', 'completed'].includes(candidate.status));
  if (followUps.length > 1) throw new Error('Multiple delivery follow-up owners require reconciliation');
  if (followUps.length === 1) {
    const current = await getAgentRecord(agentId);
    if (current?.status !== 'completed' || current.taskId !== persisted.id
      || current.result?.executionSuccess !== true || current.result?.validationPassed === false) return {};
    const { recordRepoStateVerification, updateAgent } = await import('./cosAgentLifecycle.js');
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
    return {};
  }

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

/**
 * The follow-up's reviewer roster before the forge identity preflight.
 * Self-review empties it HERE rather than at each caller: "the agent reviews it
 * itself" and "these reviewers review it" are mutually exclusive, and the
 * non-obvious half is the usernames — a single `@login` inherited from the Code
 * Review Defaults keeps the roster non-empty and quietly puts the run back on
 * the delegated path the caller opted out of.
 *
 * An EXPLICITLY empty reviewer list means "no review was requested" and must
 * stay empty — normalizeReviewers' `[copilot]` default would otherwise resurrect
 * a reviewer. CLI-based reviewers work on any forge because the agent invokes the
 * CLI directly; copilot is dropped on a non-GitHub forge. GitHub reviewer
 * usernames and the non-blocking (`~opt`) marker set are forge-agnostic and are
 * NOT stripped there — a username reviewer alone can drive the loop.
 */
function resolveReviewRoster({ reviewers, usernames, optionalReviewers, selfReview, isNonGithubForge }) {
  if (selfReview) return { reviewers: [], usernames: [], optionalReviewers: [] };
  const reviewerList = Array.isArray(reviewers) && reviewers.length === 0 ? [] : normalizeReviewers({ reviewers });
  return {
    reviewers: prioritizeToolFreeReviewers(isNonGithubForge ? reviewerList.filter(r => r !== DEFAULT_REVIEWER) : reviewerList),
    usernames: normalizeReviewUsernames(usernames),
    optionalReviewers: normalizeOptionalReviewers(optionalReviewers) || [],
  };
}

function throwRequiredReviewerFault(entries, summary, code) {
  const detail = entries.map((e) => `@${e.token}: ${e.reason}`).join('; ');
  throw new ServerError(`${summary} — ${detail}. Fix it in Settings → Code Reviewers.`, {
    status: 409, code, context: { reviewers: entries.map((e) => e.token) },
  });
}

/**
 * Target-forge identity preflight (#13115). A handle the forge verifiably does
 * not have (or the PR's own author) would fail every PR-side request. A REQUIRED
 * one fails closed — the run must not merge without the review the operator
 * demanded; an OPTIONAL one is left out of this run's emitted roster and recorded
 * in `faults`, never reported clean. Lookups that merely fail (auth/transport)
 * are inconclusive and change nothing. The saved roster is never rewritten.
 */
async function preflightReviewerRoster({ usernames, optionalReviewers, isNonGithubForge, parsedPr }) {
  const unchanged = { usernames, optionalReviewers, faults: [] };
  if (!usernames.length && !optionalReviewers.length) return unchanged;
  const { preflightReviewerIdentities, preflightReviewerPrAuthor } = await import('./reviewerIdentity.js');
  const preflight = await preflightReviewerIdentities({
    usernames, optionalReviewers, forge: isNonGithubForge ? 'gitlab' : 'github', host: parsedPr?.host,
  });
  if (preflight.requiredMissing.length) {
    throwRequiredReviewerFault(preflight.requiredMissing, 'Required reviewer not found on the target forge', 'REVIEWER_IDENTITY_NOT_FOUND');
  }
  const eligibility = isNonGithubForge ? { required: [], optional: [] } : await preflightReviewerPrAuthor({ usernames, optionalReviewers, pr: parsedPr });
  if (eligibility.required.length) {
    throwRequiredReviewerFault(eligibility.required, 'Required reviewer configuration fault', 'REVIEWER_IS_PR_AUTHOR');
  }
  const optionalFaults = [...preflight.optionalMissing, ...eligibility.optional];
  if (!optionalFaults.length) return unchanged;
  const dropped = new Set(optionalFaults.map((e) => e.token.toLowerCase()));
  const faults = optionalFaults.map(({ token, reason }) => ({ token, reason }));
  console.log(`🚫 Optional reviewer(s) unavailable for this run: ${faults.map((f) => `@${f.token}`).join(', ')}`);
  return {
    usernames: usernames.filter((u) => !dropped.has(u.toLowerCase())),
    optionalReviewers: optionalReviewers.filter((r) => !dropped.has(r.replace(/^@/, '').toLowerCase())),
    faults,
  };
}

/**
 * One place that names the follow-up mode, so the title, the log line, and the
 * warning can't drift apart as the follow-up kinds evolve.
 */
function describeFollowUpKind({ mergeOnly, selfReviewMerge, reviewers, usernames }) {
  if (!mergeOnly) return { title: 'Review Loop', label: 'review-loop', reviewers: [...reviewers, ...usernames.map(u => `@${u}`)].join(', ') };
  if (selfReviewMerge) return { title: 'Self-Review & Merge', label: 'self-review-merge', reviewers: 'self-review, no delegated reviewer' };
  return { title: 'Merge', label: 'merge', reviewers: 'merge on green CI, no review' };
}

/**
 * The source task's provider/model/effort pins, for a follow-up that runs a
 * coding harness (it fixes checks, resolves conflicts, drives reviewer CLIs). An
 * install whose ACTIVE provider is api-only would permanently reject an unpinned
 * follow-up for lacking a harness — and the PR it was spawned to land would sit
 * open forever. Only what is actually pinned is copied; an unpinned source task
 * still resolves through the normal active-provider path.
 *
 * The model pin rides ONLY with its provider: a bare `model` would be treated as
 * explicit against whatever provider resolution later picks, handing e.g. a
 * Claude model id to Codex. Effort is provider-agnostic, so it travels alone.
 */
function inheritProviderPins(sourceMeta) {
  const pins = {};
  const provider = sourceMeta.provider || sourceMeta.providerId || null;
  if (provider) {
    pins.provider = provider;
    pins.providerId = provider;
    if (sourceMeta.model) pins.model = sourceMeta.model;
  }
  if (sourceMeta.effort) pins.effort = sourceMeta.effort;
  if (sourceMeta.executionOptions !== undefined) pins.executionOptions = sourceMeta.executionOptions;
  return pins;
}

/**
 * Spawn an internal follow-up task that drives the ordered multi-reviewer
 * review-and-fix loop on the just-created PR until the configured reviewer chain
 * is satisfied, then merges the PR. This is what makes the user-facing "review
 * loop" actually loop — the original agent only opens the PR (and at most
 * pre-requests Copilot when it leads) and exits; without this follow-up the loop
 * ends after one iteration and the PR is never merged.
 *
 * `reviewers` is the ordered list (e.g. `[codex, antigravity, copilot]`); the follow-up
 * runs each in order — invoking the CLI reviewers itself and requesting Copilot at
 * its turn — honoring `reviewStopMode` (`all`/`on-findings`/`on-clean`) and
 * `reviewerApplies`. Copilot is GitHub-only, so it is stripped here on non-GitHub
 * forges. `usernames` are arbitrary GitHub reviewer usernames the follow-up
 * requests as PR reviewers to gate the merge — forge-agnostic, so never stripped.
 *
 * `prCompletion` is resolved before this function is called. It selects review
 * then merge versus merge on green directly; `leave-open` is intentional and
 * returns without creating a follow-up.
 *
 * The follow-up task uses an isolated worktree attached to the existing PR branch
 * through its canonical `reviewLoopPRBranch`, so it can fix-and-push without
 * trampling concurrent agents. `forkHead` is where that branch lives when the PR
 * came from a FORK — such a head has no `origin/<branch>` for the attach to
 * resolve, so without it the follow-up is queued and then blocked at workspace
 * prep for exactly the PRs external contributors open (#6064). Persisted beside
 * the branch name and threaded back out by `agentWorkspacePrep`; a same-repo PR
 * passes null and nothing changes.
 *
 * `dispatch` decides WHO starts the task:
 *   `'queue'`     (default) — the autonomous lane. The task is persisted and the
 *                 ordinary `tasks:changed` dequeue picks it up, which is correct
 *                 for a follow-up spawned by cleanup/prWatcher: the run that
 *                 produced the PR was itself autonomous, so its continuation
 *                 belongs under the CoS auto-run gate and daily action budget.
 *   `'immediate'` — an explicit human action (the app PR page's "Resolve &
 *                 merge"). The dequeue's Priority-2 tier only spawns
 *                 auto-approved system tasks while CoS auto-run is in `execute`
 *                 and under budget, so a queued follow-up would sit `pending`
 *                 until the user pressed Run now on the task page — the whole
 *                 point of the button was not having to. This suppresses the
 *                 automatic dequeue and force-spawns the task instead (same path
 *                 as that Run now button), reporting the outcome as `dispatch`.
 *
 * `selfReview` says the follow-up agent is the reviewer: it EMPTIES the roster
 * (reviewers, usernames and the `~opt` set alike) and then marks the resulting
 * no-roster run as one that still owes the change a review. That distinction is
 * the whole point — an empty roster has always meant "nothing reviews this, just
 * land it on green CI", and that stays what it means without this flag.
 * Deliberately ignored on a `merge-on-green` run, where the caller asked for no
 * review at all rather than for an undelegated one.
 *
 * Returns the follow-up task, or — when an equivalent follow-up was already
 * queued — that existing task with `duplicate: true`. `dispatch: 'immediate'`
 * additionally stamps `dispatch: { started, reason }` so the caller can say
 * whether an agent actually started or the task is still waiting (no slots,
 * daemon stopped, …) rather than guessing.
 */
export async function spawnReviewLoopFollowUp({ originalAgentId, originalTask, prUrl, prBranch, forkHead = null, sourceWorkspace, prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, reviewerModels = null, reviewerEfforts = null, leaveOpen = false, selfReview = false, dispatch = 'queue', reviewTarget = null }) {
  if (!prUrl || !prBranch) return null;
  if (prCompletion === PR_COMPLETIONS.LEAVE_OPEN) return null;

  if (reviewTarget) {
    const { validateCleanupReviewTarget } = await import('./cosMergeHandoff.js');
    if (reviewTarget.prUrl !== prUrl || reviewTarget.branch !== prBranch
      || reviewTarget.ownerTaskId !== originalTask?.id || reviewTarget.ownerId !== originalAgentId) return { blocked: 'Review recovery identity changed' };
    const refused = await validateCleanupReviewTarget({ target: reviewTarget, workspacePath: sourceWorkspace });
    if (refused) return { blocked: refused };
  }

  // Recovery belongs to the same durable task. A fresh sys-rl task resets the
  // spawn budget on every CI/conflict handoff and recursively nests its title.
  // The id hint also recovers receipts written before the marker was retained.
  if (isTruthyMeta(originalTask?.metadata?.reviewLoopFollowUp) || originalTask?.id?.startsWith('sys-rl-')) {
    return resumeReviewLoopCoordinator(originalTask.id, prUrl, prBranch, reviewTarget);
  }

  const parsedPr = git.parsePullRequestUrl(prUrl);
  // Copilot is GitHub-only. Classify with the shared detector rather than
  // `host !== 'github.com'` — a GitHub Enterprise host still has Copilot, and
  // misreading it as non-GitHub would strip the only reviewer and silently
  // downgrade the run to merge-only.
  const isNonGithubForge = !!parsedPr?.host && detectForgeCli(parsedPr.host) !== 'gh';
  const roster = resolveReviewRoster({ reviewers, usernames, optionalReviewers, selfReview, isNonGithubForge });
  const effectiveReviewers = roster.reviewers;
  const { usernames: effectiveUsernames, optionalReviewers: effectiveOptionalReviewers, faults: reviewerIdentityFaults } = await preflightReviewerRoster({
    usernames: roster.usernames, optionalReviewers: roster.optionalReviewers, isNonGithubForge, parsedPr,
  });
  // Per-reviewer iteration caps (`~max=<n>`) — forge-agnostic, threaded verbatim
  // so the follow-up's `--review-with` carries the same budgets. Entries for
  // reviewers that were stripped are inert (the emitter only marks tokens it
  // actually emits), so no narrowing is needed here.
  const effectiveReviewerMaxRounds = normalizeReviewerMaxRounds(reviewerMaxRounds) || {};
  // A review WAS asked for, but nothing is left to perform it — a legacy review
  // loop whose GitHub-only reviewer vanished on another forge (which retains its
  // prior merge-only fallback rather than leaving an orphaned PR), or a caller
  // that deliberately resolved no roster. Named rather than inlined into
  // `mergeOnly`, because the self-review branch below is exactly this case and
  // re-deriving it by conjunction reads as a condition that might contradict it.
  const noRosterMerge = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE
    && effectiveReviewers.length === 0 && effectiveUsernames.length === 0;
  // Merge-on-green deliberately skips every reviewer.
  const mergeOnly = prCompletion === PR_COMPLETIONS.MERGE_ON_GREEN || noRosterMerge;
  // The follow-up reviews the change ITSELF before the CI gate. Only meaningful
  // on the no-roster path — with reviewers configured the review loop already
  // runs — and never on a `merge-on-green` run, where the caller asked for no
  // review at all rather than for an undelegated one.
  const selfReviewMerge = selfReview && noRosterMerge;
  // ...and with nothing to review AND nothing to merge there is no follow-up at
  // all (a JIRA-tracked task whose reviewers were all stripped). The caller
  // normally catches this; the guard keeps the invariant local to this function.
  if (mergeOnly && leaveOpen) return null;

  // Reviewer-keyed model map, narrowed to the model-selectable reviewers actually
  // in this loop's list (e.g. `{ codex: 'gpt-5.6-sol', ollama: 'qwen2.5:7b' }`).
  // The prompt threads a CLI reviewer's model as `<reviewer> --model <id>` and a
  // local-LLM reviewer's as the `model` field of its `/api/code-review/local` body.
  // `reviewerModels` is already coerced to string values upstream
  // (resolveReviewLoopOptions).
  // Empty → null so the prompt builder's "nothing configured" path is unambiguous.
  const narrowPins = (pins, roster) => {
    const out = Object.fromEntries(effectiveReviewers
      .filter(r => (roster.includes(r) || isProviderReviewer(r)) && pins?.[r])
      .map(r => [r, pins[r]]));
    return Object.keys(out).length ? out : null;
  };
  const narrowedReviewerModels = narrowPins(reviewerModels, MODEL_SELECTABLE_REVIEWERS);
  // Reviewer-keyed reasoning-effort map, narrowed the same way. The prompt turns a
  // CLI reviewer's effort into a flag on its command line (`--effort high` /
  // `-c model_reasoning_effort=high`, or a folded `--model gpt-5[effort=max]` for
  // cursor, whose CLI has no effort flag) and a local-LLM reviewer's into the
  // `reasoning_effort` field of its `/api/code-review/local` body.
  const narrowedReviewerEfforts = narrowPins(reviewerEfforts, EFFORT_SELECTABLE_REVIEWERS);

  // One place that names the mode, so the title, the log line, and the warning
  // can't drift apart as the two follow-up kinds evolve.
  const kind = describeFollowUpKind({ mergeOnly, selfReviewMerge, reviewers: effectiveReviewers, usernames: effectiveUsernames });

  const providerPins = inheritProviderPins(originalTask?.metadata || {});

  // Routing key, and the one field here that turns a serialization slip into a
  // dead PR: a follow-up whose `app` doesn't resolve is BLOCKED by
  // prepareAgentWorkspace before it starts, so the PR it exists to land sits
  // open forever. Left undefined (not `null`) for a PortOS-local task —
  // generateTasksMarkdown drops nullish metadata, so the key never reaches the
  // task file to be re-read as an app literally named "null".
  const appId = originalTask?.metadata?.app;
  const sourceTaskDesc = originalTask?.description || 'CoS automated task';
  const firstLine = sourceTaskDesc.split(/[\r\n]/).find(l => l.trim()) || sourceTaskDesc;
  const followUpTitle = `[${kind.title}] ${firstLine.trim().substring(0, 80)} (${prUrl})`;

  const reviewLoopForkTarget = forkHead && !leaveOpen
    ? await (await import('./forkReviewMergeTarget.js')).captureForkReviewMergeTarget({ prUrl, prBranch, forkHead, sourceWorkspace })
    : null;

  const followUpTaskId = `sys-rl-${Date.now().toString(36)}`;
  const followUpTask = {
    id: followUpTaskId,
    status: 'pending',
    priority: (originalTask?.priority || 'MEDIUM').toUpperCase(),
    priorityValue: 2,
    description: followUpTitle,
    metadata: {
      app: appId,
      ...providerPins,
      // useWorktree is required so the follow-up runs in isolation. Its canonical
      // reviewLoopPRBranch below tells the shared resolver which PR branch to attach.
      useWorktree: true,
      // openPR/reviewLoop must stay false so cleanup doesn't try to create another PR
      // or request another initial review (the agent itself drives the loop)
      openPR: false,
      reviewLoop: false,
      simplify: false,
      // Marker flags consumed by the agent prompt + completion handler
      reviewLoopFollowUp: true,
      ...(reviewTarget ? { cleanupReviewTarget: reviewTarget, resumeWorktreePath: reviewTarget.worktreePath } : {}),
      prCompletion,
      // Merge-only run: no reviewers, the prompt is a CI-gate-and-merge procedure.
      reviewLoopMergeOnly: mergeOnly,
      // …and, on that same path, whether the agent owes the change its OWN
      // review first. Read by `buildMergeFollowUpSection`, which is why it sits
      // beside the flag that selects that section rather than in the roster keys
      // below — there is no roster in this mode.
      reviewLoopSelfReview: selfReviewMerge,
      // Review, but do NOT merge — the PR is a human's to land (JIRA hand-off).
      reviewLoopLeaveOpen: leaveOpen,
      reviewLoopPRUrl: prUrl,
      reviewLoopPRBranch: prBranch,
      // Fork coordinates for that branch, or null for a same-repo head. The
      // shared reader is `resolveTaskForkHead`, so this key is the generic
      // `forkHead` rather than a review-loop-specific one.
      forkHead: normalizeForkHead(forkHead),
      reviewLoopForkTarget,
      reviewLoopPRNumber: parsedPr?.number ?? null,
      reviewLoopPRHost: parsedPr?.host ?? null,
      reviewLoopPROwner: parsedPr?.owner ?? null,
      reviewLoopPRRepo: parsedPr?.repo ?? null,
      reviewLoopReviewers: effectiveReviewers,
      // Arbitrary GitHub reviewer usernames the follow-up requests as PR reviewers
      // and gates the merge on (appended to `--review-with` as `@user`).
      reviewLoopReviewerUsernames: effectiveUsernames,
      reviewLoopOptionalReviewers: effectiveOptionalReviewers,
      ...(reviewerIdentityFaults.length ? { reviewLoopReviewerIdentityFaults: reviewerIdentityFaults } : {}),
      // Per-reviewer `~max=<n>` caps, keyed by emitted token. Empty object = no
      // caps (leaves slashdo's per-loop built-in default in place); an absent key
      // is NOT `0`, which slashdo reads as "loop until clean".
      reviewLoopReviewerMaxRounds: effectiveReviewerMaxRounds,
      reviewLoopStopMode: reviewStopMode,
      // Public PR/MR diffs are untrusted input. Review subprocesses stay
      // advisory/read-only; the follow-up agent independently applies fixes.
      reviewLoopReviewerApplies: false,
      reviewLoopReviewerModels: narrowedReviewerModels,
      reviewLoopReviewerEfforts: narrowedReviewerEfforts,
      // Back-compat: older installs' prompt builder reads only the codex-scalar key.
      // Mirror the (already-narrowed) codex entry so a follow-up task persisted by this
      // version still threads a codex model after a downgrade. Remove once no supported
      // peer reads it.
      reviewLoopCodexModel: narrowedReviewerModels?.codex || null,
      sourceTaskId: originalTask?.id || null,
      sourceAgentId: originalAgentId || null,
      // This follow-up may legitimately exit with zero new commits when every
      // reviewer comes back clean — completion handling must not treat a
      // zero-commit exit as a failure.
      readOnly: false
    },
    autoApproved: true,
    section: 'pending'
  };

  // An immediate dispatch owns the spawn, so the automatic dequeue is suppressed:
  // otherwise it races this force-spawn for the same task and whichever loses
  // reports a bogus failure for a run that did start (see the `suppressDequeue`
  // contract on cos.js's `tasks:changed` listener).
  const immediate = dispatch === 'immediate';
  const persisted = await addTask(followUpTask, 'internal', { raw: true, suppressDequeue: immediate });

  // A duplicate rejection persisted NOTHING under `followUpTaskId` — an equivalent
  // follow-up is already queued under a different id. Return THAT record so a
  // caller reports (and force-spawns) the task that actually exists instead of the
  // id we just minted, which `forceSpawnTask` would answer with "Task not found".
  if (persisted?.duplicate) {
    emitLog('info', `🔁 ${kind.label} follow-up for PR ${prUrl} matched already-queued task ${persisted.id}`, {
      taskId: persisted.id, prUrl, prBranch, sourceAgentId: originalAgentId, sourceTaskId: originalTask?.id
    });
    return persisted;
  }

  emitLog('info', `🔁 Spawned ${kind.label} follow-up task ${followUpTaskId} (${kind.reviewers}) for PR ${prUrl}`, {
    taskId: followUpTaskId, prUrl, prBranch, sourceAgentId: originalAgentId, sourceTaskId: originalTask?.id
  });
  if (!immediate) return followUpTask;

  // A throw here would 500 an explicit user request whose task IS already
  // persisted — report it the same way a refusal is reported instead.
  const spawn = await forceSpawnTask(followUpTaskId).catch(err => ({ error: err.message }));
  if (spawn?.error) {
    // The task stays `pending` and keeps its place in the queue — say why it has
    // not started rather than letting the caller claim an agent is running.
    emitLog('warn', `⏳ ${kind.label} follow-up ${followUpTaskId} queued but not started — ${spawn.error}`, {
      taskId: followUpTaskId, prUrl
    });
    return { ...followUpTask, dispatch: { started: false, reason: spawn.error } };
  }
  emitLog('info', `⚡ Started ${kind.label} follow-up ${followUpTaskId} immediately for PR ${prUrl}`, {
    taskId: followUpTaskId, prUrl
  });
  return { ...followUpTask, dispatch: { started: true, reason: null } };
}

async function resumeReviewLoopCoordinator(taskId, prUrl, prBranch, reviewTarget = null) {
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(taskId);
  if (!task || task.taskType !== 'internal' || !isTruthyMeta(task.metadata?.reviewLoopFollowUp)
    || task.metadata.reviewLoopPRUrl !== prUrl || task.metadata.reviewLoopPRBranch !== prBranch) {
    return { id: taskId, blocked: 'Review coordinator identity could not be verified' };
  }
  if (prHeldForOperator(task)) {
    return { id: taskId, blocked: 'Review coordinator leaves this PR for its human owner' };
  }
  // Finalization can mark the task complete before its worker finishes cleanup.
  // Keep the receipt until that owner releases, including across daemon restarts.
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
  const agents = await readClaimOwnershipAgents();
  if (!agents) return { id: taskId, deferred: true };
  if (task.status === 'in_progress' || agents.some(agent => (agent.taskId === taskId
    || agent.metadata?.reviewLoopMergeTarget?.url === prUrl)
    && ['running', 'paused', 'orphaned', 'interrupted'].includes(agent.status))) {
    return { id: taskId, deferred: true };
  }
  if (task.status === 'pending') return { id: taskId, duplicate: true };
  if (task.status !== 'completed') return { id: taskId, blocked: `Review coordinator is ${task.status}` };
  const { MAX_TOTAL_SPAWNS } = await import('../lib/cosValidation.js');
  const count = Number(task.metadata.totalSpawnCount);
  if (!Number.isInteger(count) || count < 1 || count >= MAX_TOTAL_SPAWNS) {
    return { id: taskId, blocked: 'Review coordinator retry budget exhausted or unreadable' };
  }
  const result = await updateTask(taskId, {
    status: 'pending',
    metadata: { reviewLoopRecoveryReason: 'The handed-off PR needs fresh validation, review or conflict resolution',
      ...(reviewTarget ? { cleanupReviewTarget: reviewTarget, resumeWorktreePath: reviewTarget.worktreePath } : {}) },
  }, 'internal', {
    expectedStatus: 'completed',
    expectedMetadata: Object.fromEntries([
      'totalSpawnCount', 'reviewLoopFollowUp', 'reviewLoopPRUrl', 'reviewLoopPRBranch',
      'prCompletion', 'reviewLoopLeaveOpen', 'readOnly', 'jiraTicketId', 'analysisType', 'updatedAt',
    ].map(key => [key, task.metadata[key]])),
  });
  if (result?.error) throw new Error(result.error);
  if (result?.statusChanged) return { id: taskId, deferred: true };
  emitLog('info', `🔁 Resumed review coordinator ${taskId} for PR ${prUrl} (${count}/${MAX_TOTAL_SPAWNS} runs used)`, { taskId, prUrl });
  return { id: taskId, resumed: true };
}

/** Retain warning recovery on the original completion receipt. No new agent,
 * retry budget or personal obligation is created by a cleanup warning. */
export async function spawnMergeRecoveryTask(cleanupWarnings, agentId, task, appName, sourceWorkspace) {
  if (!cleanupWarnings?.length || !agentId || !sourceWorkspace) return null;
  // Draft/review-only delivery remains with its explicit owner. A warning
  // cannot grant the completion sweep authority to retire that checkout.
  if (resolvePrCompletion(task?.metadata) === PR_COMPLETIONS.LEAVE_OPEN) return null;
  const { getAgentRecord, recordCleanupOutcome, recordRepoStateVerification } = await import('./cosAgentLifecycle.js');
  const agent = await getAgentRecord(agentId);
  const branch = agent?.metadata?.worktreeBranch || agent?.metadata?.claimBranch
    || cleanupWarnings.map(warning => warning.match(/(?:Auto-merge failed|PR creation failed) for branch (\S+?)(?=:|\s|$)/)?.[1]).find(Boolean);
  if (branch) {
    const recorded = await recordCleanupOutcome(agentId, { status: 'pending', reason: 'cleanup-warning-pending', branch,
      path: agent?.metadata?.worktreePath || null, warnings: cleanupWarnings, sourceWorkspace, taskId: task?.id || null });
    if (!recorded) throw new Error('cleanup-warning-receipt-unavailable');
  }
  const pending = await recordRepoStateVerification(agentId, { status: 'pending', reasons: ['cleanup-warning-pending'] });
  if (!pending) throw new Error('cleanup-warning-replay-unavailable');
  emitLog('info', 'Cleanup warning retained for deterministic completion recovery', { agentId, appName });
  return null;
}

// A verification continuation deliberately retains even an already-merged
// branch. Ordinary failed-task retry correctly discards those resume pointers.
async function runtimeResumePatch({ task, agentId, agentMetadata }) {
  const claim = await resolveClaimContinuationPatch({ task, agentId, agentMetadata });
  if (claim) return claim;
  if (hasClaimFlowContract(task)) throw new Error('Runtime verification claim checkout identity is unavailable; retain the prerequisite');
  if (!agentMetadata?.isWorktree || agentMetadata.isPersistentWorktree) return {};
  const branch = agentMetadata.worktreeBranch;
  const path = agentMetadata.workspacePath || join(PATHS.worktrees, agentId);
  if (!branch || !existsSync(path) || await git.getBranch(path) !== branch) {
    throw new Error('Runtime verification checkout identity is unavailable; retain the prerequisite');
  }
  return { existingBranch: branch, resumeWorktreePath: path, resumedFromAgentId: agentId };
}
