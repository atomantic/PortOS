/**
 * Agent Worktree Cleanup
 *
 * Post-completion worktree handling for agents: merge-or-PR the worktree
 * branch, drive the multi-reviewer review-loop follow-up, and auto-create
 * recovery tasks when a merge or PR creation fails. Extracted from
 * agentLifecycle.js as a self-contained leaf so the completion-cleanup
 * orchestrator (agentCompletionCleanup.js) can import it without a circular
 * dependency back into agentLifecycle.js.
 *
 * agentLifecycle.js re-exports these three functions for backward
 * compatibility (agentManagement.js and subAgentSpawner.js import
 * `cleanupAgentWorktree` / `spawnMergeRecoveryTask` / `spawnReviewLoopFollowUp`
 * from there).
 */

import { join } from 'path';
import { emitLog } from './cosEvents.js';
import { addTask } from './cos.js';
import * as git from './git.js';
import { removeWorktree } from './worktreeManager.js';
import { isTruthyMeta } from './agentState.js';
import { PATHS } from '../lib/fileUtils.js';
import { RECOVERY_TASK_PREFIX } from './recoveryTasks.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, MODEL_CAPABLE_CLI_REVIEWERS, normalizeReviewers, normalizeReviewUsernames } from '../lib/validation.js';

/**
 * Clean up a worktree for a completed agent.
 * Reads worktree metadata from the agent's registered state and removes the worktree.
 * When openPR is true, pushes the branch and creates a PR instead of auto-merging.
 * When requestCopilotReview is also true, spawns a follow-up internal task that drives
 * the multi-reviewer loop and merges once the review chain is clean — that follow-up is
 * the part the user expects to "keep looping until ready to merge."
 * `reviewers` is the ordered reviewer list (e.g. `[codex, antigravity, copilot]`); the native
 * GitHub Copilot review is pre-requested here only when copilot LEADS the list (otherwise
 * the follow-up requests it at its turn so Copilot sees the post-fix diff). `reviewStopMode`
 * (`all`/`on-findings`/`on-clean`) and `reviewerApplies` are threaded into the follow-up's
 * metadata. CLI reviewers (claude/antigravity/codex/grok) are always driven by the follow-up agent,
 * which works on any forge; copilot is GitHub-only and dropped on non-GitHub remotes.
 * When skipMerge is true (review-loop follow-up agents), the cleanup never auto-merges
 * the worktree branch into the source workspace because `gh pr merge` already handled it.
 * Otherwise, merges the worktree branch back to the source branch on success.
 */
export async function cleanupAgentWorktree(agentId, success, { openPR = false, requestCopilotReview: shouldRequestCopilot = false, reviewers = DEFAULT_REVIEWERS, usernames = [], reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, reviewerModels = null, skipMerge = false, description = null, agentOutput = null, originalTask = null } = {}) {
  const { getAgent: getAgentState } = await import('./cos.js');
  const agentState = await getAgentState(agentId).catch(() => null);
  if (!agentState?.metadata?.isWorktree) return [];
  if (agentState?.metadata?.isPersistentWorktree) return [];

  const { sourceWorkspace, worktreeBranch } = agentState.metadata;
  if (!sourceWorkspace || !worktreeBranch) return [];

  const warnings = [];

  // Throwaway-worktree posture (programmatic-I/O reasoning agents, e.g. layered-
  // intelligence): the agent's edits are NEVER wanted — its only sanctioned output
  // is its structured `.agent-done` payload, consumed by a processTaskOutput hook.
  // Remove the worktree WITHOUT merging or opening a PR (delete the branch too), so
  // a reasoning agent that touched code can't land it. This is the "reasoner never
  // writes code" guarantee, enforced by isolation rather than by not spawning an
  // agent. Overrides openPR/skipMerge — discard always wins. Derived once here from
  // the task metadata (a pure read with no caller-specific logic, unlike openPR/
  // skipMerge) so every spawn-completion path gets it without threading a flag.
  const discardWorktree = isTruthyMeta(originalTask?.metadata?.discardWorktree);
  if (discardWorktree) {
    emitLog('info', `🌳 Discarding worktree for reasoning agent ${agentId} (no merge, no PR)`, { agentId, branchName: worktreeBranch });
    const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false }).catch(err => {
      emitLog('warn', `🌳 Worktree discard failed for ${agentId}: ${err.message}`, { agentId });
      return { warnings: [`Worktree discard failed: ${err.message}`] };
    });
    return result?.warnings || [];
  }

  // When openPR is set and task succeeded, push branch and create PR instead of auto-merging
  if (openPR && success) {
    emitLog('info', `🌳 Opening PR for worktree agent ${agentId} branch ${worktreeBranch}`, { agentId, branchName: worktreeBranch });

    const worktreePath = agentState.metadata.workspacePath || join(PATHS.worktrees, agentId);

    const [pushResult, branchInfo] = await Promise.all([
      git.push(worktreePath, worktreeBranch).then(() => true).catch(err => {
        emitLog('warn', `🌳 Failed to push worktree branch ${worktreeBranch}: ${err.message}`, { agentId });
        return false;
      }),
      git.getRepoBranches(sourceWorkspace).catch(() => ({ baseBranch: null, devBranch: null }))
    ]);

    if (pushResult) {
      let targetBranch = branchInfo.baseBranch;
      if (!targetBranch) {
        targetBranch = await git.getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null) || 'main';
      }
      const prTitle = await git.suggestPRTitle(worktreePath, targetBranch, worktreeBranch, description);

      const prBody = await git.generatePRDescription(worktreePath, targetBranch, worktreeBranch, agentOutput);

      const prResult = await git.createPR(worktreePath, {
        title: prTitle,
        body: prBody,
        base: targetBranch,
        head: worktreeBranch
      }).catch(err => {
        emitLog('warn', `🌳 Failed to create PR for ${worktreeBranch}: ${err.message}`, { agentId });
        return null;
      });

      if (!prResult?.success) {
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
          const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false }).catch(err => {
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

      const cliName = prResult.cli || 'gh';
      emitLog('success', `🌳 Created PR: ${prResult.url} (${cliName}${prResult.account ? ` authed as ${prResult.account}` : ''})`, { agentId, branchName: worktreeBranch, cli: prResult.cli, account: prResult.account, owner: prResult.owner, host: prResult.host });

      const reviewerList = normalizeReviewers({ reviewers });
      const copilotIsFirst = reviewerList[0] === DEFAULT_REVIEWER;
      const nonCopilotReviewers = reviewerList.filter(r => r !== DEFAULT_REVIEWER);
      // Pre-request the native Copilot review ONLY when copilot LEADS the order — it
      // then reviews the freshly-opened PR. When copilot is configured after a CLI
      // reviewer (e.g. [codex, copilot]), pre-requesting now would make Copilot review
      // the stale pre-CLI-fix diff; instead the follow-up agent requests it at copilot's
      // turn, after the earlier reviewer's fixes are pushed. This pre-request is a
      // latency optimization only — the follow-up requests Copilot at its turn
      // regardless, so a failed/absent pre-request is recoverable (no reviewer dropped).
      if (shouldRequestCopilot && copilotIsFirst) {
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
      if (shouldRequestCopilot && nonCopilotReviewers.length > 0) {
        emitLog('info', `🤖 Follow-up will run CLI reviewers: ${nonCopilotReviewers.join(', ')}`, { agentId, prUrl: prResult.url });
      }

      // Spawn the review-loop follow-up agent that runs the multi-reviewer loop until
      // clean and merges. Hand it the FULL ordered list — the follow-up requests Copilot
      // at copilot's turn (so a failed pre-request or copilot-only config still gets a
      // review pass) and invokes the CLI reviewers itself. The only reviewer dropped is
      // copilot on a non-GitHub forge, handled centrally in spawnReviewLoopFollowUp.
      const canSpawnFollowUp = shouldRequestCopilot && reviewerList.length > 0;
      if (canSpawnFollowUp) {
        await spawnReviewLoopFollowUp({
          originalAgentId: agentId,
          originalTask,
          prUrl: prResult.url,
          prBranch: worktreeBranch,
          sourceWorkspace,
          reviewers: reviewerList,
          usernames,
          reviewStopMode,
          reviewerApplies,
          reviewerModels
        }).catch(err => {
          emitLog('warn', `🤖 Failed to spawn review-loop follow-up for ${prResult.url}: ${err.message}`, { agentId, prUrl: prResult.url });
          warnings.push(`Review-loop follow-up spawn failed for ${prResult.url}: ${err.message}`);
        });
      }

      const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false }).catch(err => {
        emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
        return { warnings: [`Worktree cleanup failed: ${err.message}`] };
      });
      warnings.push(...(result?.warnings || []));
      return warnings;
    }

    // Push failed — preserve worktree/branch for manual intervention
    warnings.push(`Push failed for branch ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`);
    emitLog('warn', `🌳 Push failed for ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`, { agentId, branchName: worktreeBranch });
    return warnings;
  }

  // Default: auto-merge on success, just cleanup on failure.
  // Review-loop follow-up agents pass skipMerge: true because gh pr merge already
  // handled the merge upstream — re-merging the worktree branch into the local
  // source workspace would duplicate the squashed commits.
  const shouldMerge = success && !skipMerge;
  emitLog('info', `🌳 Cleaning up worktree for agent ${agentId} (merge: ${shouldMerge})`, {
    agentId, branchName: worktreeBranch, merge: shouldMerge
  });

  const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: shouldMerge }).catch(err => {
    emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
    return { warnings: [`Worktree cleanup failed: ${err.message}`] };
  });
  warnings.push(...(result?.warnings || []));
  return warnings;
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
 * forges; if that empties the list AND no `usernames` are configured, no follow-up
 * is spawned. `usernames` are arbitrary GitHub reviewer usernames the follow-up
 * requests as PR reviewers to gate the merge — forge-agnostic, so never stripped.
 *
 * The follow-up task uses an isolated worktree attached to the existing PR
 * branch (via createWorktree's `existingBranch` option) so it can fix-and-push
 * without trampling concurrent agents.
 */
export async function spawnReviewLoopFollowUp({ originalAgentId, originalTask, prUrl, prBranch, sourceWorkspace, reviewers = DEFAULT_REVIEWERS, usernames = [], reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, reviewerModels = null }) {
  if (!prUrl || !prBranch) return null;

  const parsedPr = git.parsePullRequestUrl(prUrl);
  // Copilot is GitHub-only; CLI-based reviewers (claude/antigravity/codex/grok) work on any
  // forge because the agent invokes the CLI directly. On a non-GitHub forge, drop
  // copilot from the list — if nothing's left (and no username reviewers), there's
  // no review to run.
  const isNonGithubForge = parsedPr && parsedPr.host && parsedPr.host !== 'github.com';
  const reviewerList = normalizeReviewers({ reviewers });
  const effectiveReviewers = isNonGithubForge ? reviewerList.filter(r => r !== DEFAULT_REVIEWER) : reviewerList;
  // GitHub reviewer usernames are forge-agnostic requested reviewers, so they are
  // NOT stripped on a non-GitHub forge — a username reviewer alone can drive the
  // loop even when copilot was dropped.
  const effectiveUsernames = normalizeReviewUsernames(usernames);
  if (effectiveReviewers.length === 0 && effectiveUsernames.length === 0) return null;

  // Reviewer-keyed CLI model map, narrowed to the model-capable reviewers actually
  // in this loop's list (e.g. `{ codex: 'gpt-5.6-sol', claude: 'qwen2.5:7b' }`); the
  // prompt threads each as `<reviewer> --model <id>`. `reviewerModels` is already
  // coerced to string values upstream (resolveReviewLoopOptions).
  const narrowedReviewerModels = {};
  for (const r of effectiveReviewers) {
    if (MODEL_CAPABLE_CLI_REVIEWERS.includes(r) && reviewerModels?.[r]) narrowedReviewerModels[r] = reviewerModels[r];
  }

  const appId = originalTask?.metadata?.app || null;
  const sourceTaskDesc = originalTask?.description || 'CoS automated task';
  const firstLine = sourceTaskDesc.split(/[\r\n]/).find(l => l.trim()) || sourceTaskDesc;
  const followUpTitle = `[Review Loop] ${firstLine.trim().substring(0, 80)} (${prUrl})`;

  const followUpTaskId = `sys-rl-${Date.now().toString(36)}`;
  const followUpTask = {
    id: followUpTaskId,
    status: 'pending',
    priority: (originalTask?.priority || 'MEDIUM').toUpperCase(),
    priorityValue: 2,
    description: followUpTitle,
    metadata: {
      app: appId,
      // useWorktree is required so the follow-up runs in isolation; existingBranch
      // tells createWorktree to attach to the PR branch instead of cutting a new one.
      useWorktree: true,
      existingBranch: prBranch,
      // openPR/reviewLoop must stay false so cleanup doesn't try to create another PR
      // or request another initial review (the agent itself drives the loop)
      openPR: false,
      reviewLoop: false,
      simplify: false,
      // Marker flags consumed by the agent prompt + completion handler
      reviewLoopFollowUp: true,
      reviewLoopPRUrl: prUrl,
      reviewLoopPRBranch: prBranch,
      reviewLoopPRNumber: parsedPr?.number ?? null,
      reviewLoopPRHost: parsedPr?.host ?? null,
      reviewLoopPROwner: parsedPr?.owner ?? null,
      reviewLoopPRRepo: parsedPr?.repo ?? null,
      reviewLoopReviewers: effectiveReviewers,
      // Arbitrary GitHub reviewer usernames the follow-up requests as PR reviewers
      // and gates the merge on (appended to `--review-with` as `@user`).
      reviewLoopReviewerUsernames: effectiveUsernames,
      reviewLoopStopMode: reviewStopMode,
      reviewLoopReviewerApplies: reviewerApplies,
      // Empty → null so the prompt builder's "no models configured" path is unambiguous.
      reviewLoopReviewerModels: Object.keys(narrowedReviewerModels).length ? narrowedReviewerModels : null,
      // Back-compat: older installs' prompt builder reads only the codex-scalar key.
      // Mirror the (already-narrowed) codex entry so a follow-up task persisted by this
      // version still threads a codex model after a downgrade. Remove once no supported
      // peer reads it.
      reviewLoopCodexModel: narrowedReviewerModels.codex || null,
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

  await addTask(followUpTask, 'internal', { raw: true });
  const reviewLoopLabel = [...effectiveReviewers, ...effectiveUsernames.map(u => `@${u}`)].join(', ');
  emitLog('info', `🔁 Spawned review-loop follow-up task ${followUpTaskId} (${reviewLoopLabel}) for PR ${prUrl}`, {
    taskId: followUpTaskId, prUrl, prBranch, sourceAgentId: originalAgentId, sourceTaskId: originalTask?.id
  });
  return followUpTask;
}

/**
 * Auto-create a recovery task when a worktree merge or PR creation fails, so stale
 * branches don't accumulate in managed app repos and block future agent work.
 */
export async function spawnMergeRecoveryTask(cleanupWarnings, agentId, task, appName, sourceWorkspace) {
  let staleBranch = null;
  let isMergeFail = false;

  for (const w of cleanupWarnings) {
    const mergeMatch = w.match(/Auto-merge failed for branch (\S+)/);
    if (mergeMatch) { staleBranch = mergeMatch[1]; isMergeFail = true; break; }

    const prMatch = w.match(/PR creation failed for branch (\S+?):/);
    if (prMatch) { staleBranch = prMatch[1]; break; }
  }

  if (!staleBranch || !sourceWorkspace) return;

  const appId = task?.metadata?.app;

  if (isMergeFail) {
    const defaultBr = await git.getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
    addTask({
      description: `${RECOVERY_TASK_PREFIX} Resolve merge conflict and clean up stale branch ${staleBranch} in ${appName}`,
      priority: 'HIGH',
      app: appId,
      isRecovery: true,
      context: `An agent failed to auto-merge branch "${staleBranch}" back to ${defaultBr} in ${sourceWorkspace}. `
        + `Resolve this by: (1) checking if the branch's changes are already on ${defaultBr} (superseded by other commits), `
        + `and if so, delete the branch with "git branch -D ${staleBranch}"; `
        + `(2) if the changes are NOT on ${defaultBr}, attempt "git merge ${staleBranch} --no-edit" from ${defaultBr}, resolve any conflicts, and commit; `
        + `(3) after merging or determining the branch is stale, delete it with "git branch -D ${staleBranch}". `
        + `Original agent: ${agentId}, original task: ${task?.description || 'unknown'}.`,
      useWorktree: false,
    }, 'user').catch(err => {
      emitLog('warn', `Failed to create merge recovery task: ${err.message}`, { agentId, staleBranch });
    });
    emitLog('info', `🔧 Auto-created merge recovery task for stale branch ${staleBranch}`, { agentId, appName });
  } else {
    // PR/MR creation failed — spawn an agent to investigate and retry. Pick gh vs
    // glab based on the repo's forge so the recovery agent gets commands that
    // actually work against this remote.
    const [{ cli }, detectedBase] = await Promise.all([
      git.resolveForgeForRepo(sourceWorkspace).catch(() => ({ cli: 'gh' })),
      git.getDefaultBranch(sourceWorkspace).catch(() => null)
    ]);
    const targetBase = detectedBase || 'main';
    const isGitLab = cli === 'glab';
    const reqWord = isGitLab ? 'MR' : 'PR';
    const listCmd = isGitLab
      ? `glab mr list --source-branch ${staleBranch}`
      : `gh pr list --head ${staleBranch}`;
    const createCmd = isGitLab
      ? `glab mr create --source-branch ${staleBranch} --target-branch ${targetBase} --title '...' --description '...'`
      : `gh pr create --head ${staleBranch} --base ${targetBase} --title '...' --body '...'`;

    addTask({
      description: `${RECOVERY_TASK_PREFIX} Investigate and retry failed ${reqWord} for branch ${staleBranch} in ${appName}`,
      priority: 'HIGH',
      app: appId,
      isRecovery: true,
      context: `An agent pushed branch "${staleBranch}" to ${sourceWorkspace} but automated ${reqWord} creation failed. `
        + `Investigate by: (1) checking if a ${reqWord} already exists for this branch: "${listCmd}"; `
        + `(2) if no ${reqWord} exists, review the branch changes and create one: "${createCmd}"; `
        + `(3) if the branch is stale or changes are already on ${targetBase}, delete the remote branch: "git push origin --delete ${staleBranch}". `
        + `Original agent: ${agentId}, original task: ${task?.description || 'unknown'}.`,
      useWorktree: false,
    }, 'user').catch(err => {
      emitLog('warn', `Failed to create ${reqWord} recovery task: ${err.message}`, { agentId, staleBranch });
    });
    emitLog('info', `🔧 Auto-created ${reqWord} recovery task for branch ${staleBranch}`, { agentId, appName, cli });
  }
}
