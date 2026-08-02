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

import { existsSync } from 'fs';
import { join } from 'path';
import { emitLog } from './cosEvents.js';
import { addTask, updateTask } from './cos.js';
import * as git from './git.js';
import { removeWorktree, classifyWorktreeDirt } from './worktreeManager.js';
import { isTruthyMeta } from './agentState.js';
import { PATHS } from '../lib/fileUtils.js';
import { isRetryHeld, clearedRetryHoldMetadata } from '../lib/taskRetryHold.js';
import { RECOVERY_TASK_PREFIX } from './recoveryTasks.js';
import { detectForgeCli } from '../lib/gitForge.js';
import { PR_COMPLETIONS, PR_COMPLETION_VALUES, leavesPrForHuman } from '../lib/prDisposition.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, MODEL_SELECTABLE_REVIEWERS, normalizeReviewers, normalizeReviewUsernames, normalizeOptionalReviewers, normalizeReviewerMaxRounds } from '../lib/validation.js';

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

/**
 * Clean up a worktree for a completed agent.
 * Reads worktree metadata from the agent's registered state and removes the worktree.
 * When openPR is true, pushes the branch and creates a PR instead of auto-merging.
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
  const run = runCleanupAgentWorktree(agentId, success, options)
    .finally(() => { inFlightCleanups.delete(agentId); });
  inFlightCleanups.set(agentId, run);
  return run;
}

async function runCleanupAgentWorktree(agentId, success, { openPR = false, prCompletion = null, requestCopilotReview: legacyRequestCopilotReview = false, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, reviewerModels = null, skipMerge = false, description = null, agentOutput = null, originalTask = null } = {}) {
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

      // Production completion paths pass a resolver-backed policy. Keep the
      // former option as a narrow compatibility fallback for direct callers.
      const resolvedPrCompletion = PR_COMPLETION_VALUES.includes(prCompletion)
        ? prCompletion
        : (legacyRequestCopilotReview ? PR_COMPLETIONS.REVIEW_THEN_MERGE : PR_COMPLETIONS.MERGE_ON_GREEN);
      const runsReviewLoop = resolvedPrCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
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

      // JIRA remains a legacy human hand-off: configured reviewers can still
      // run, but the follow-up must not merge. An explicit leave-open policy is
      // different — opening the PR is the entire requested outcome.
      const leaveOpen = leavesPrForHuman(originalTask);
      if (resolvedPrCompletion === PR_COMPLETIONS.LEAVE_OPEN) {
        emitLog('info', `🤝 Leaving ${prResult.url} open by task completion policy`, { agentId, prUrl: prResult.url });
      } else if (leaveOpen && !runsReviewLoop) {
        emitLog('info', `🤝 Leaving ${prResult.url} open for a human — JIRA-tracked task, no reviewers configured`, { agentId, prUrl: prResult.url });
      } else {
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

        if (!queuedDeterministicMerge) {
          await spawnReviewLoopFollowUp({
            originalAgentId: agentId,
            originalTask,
            prUrl: prResult.url,
            prBranch: worktreeBranch,
            sourceWorkspace,
            prCompletion: resolvedPrCompletion,
            reviewers: runsReviewLoop ? reviewerList : [],
            usernames: runsReviewLoop ? usernames : [],
            optionalReviewers: runsReviewLoop ? optionalReviewers : [],
            reviewerMaxRounds: runsReviewLoop ? reviewerMaxRounds : {},
            reviewStopMode,
            reviewerApplies,
            reviewerModels,
            leaveOpen
          }).catch(err => {
            emitLog('warn', `🤖 Failed to spawn PR follow-up for ${prResult.url}: ${err.message}`, { agentId, prUrl: prResult.url });
            warnings.push(`PR follow-up spawn failed for ${prResult.url}: ${err.message}`);
          });
        }
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

  const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, {
    merge: shouldMerge,
    // A FAILED agent's branch is the only record of what it got done. Keep it when
    // it holds commits so the task's retry can attach to it and resume rather than
    // redo the work (see resolveResumeBranch below + removeWorktree's flag docs).
    preserveBranchWithCommits: !success,
  }).catch(err => {
    emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
    return { warnings: [`Worktree cleanup failed: ${err.message}`] };
  });
  warnings.push(...(result?.warnings || []));
  return warnings;
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
export async function resolveResumePointer(sourceWorkspace, branchName, worktreePath = null) {
  if (!sourceWorkspace || !branchName) return null;

  const survivingTree = !!(worktreePath && existsSync(worktreePath));
  const target = await git.getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
  // Same predicate `removeWorktree` used to decide whether to KEEP this branch, so
  // the two can't disagree and orphan it. `isBranchMergedInto` (not a rev-list
  // count) because a rebase/squash-merged branch has new SHAs and would otherwise
  // read as resumable — pointing a retry at already-landed work. Note the polarity
  // flips here: preservation fails closed (keep), but resuming fails OPEN (start
  // clean), because a wrong resume makes an agent build on a merged branch while a
  // wrong clean start merely repeats work the branch still holds for a human.
  const merged = await git.isBranchMergedInto(sourceWorkspace, branchName, target).catch(() => true);
  // Nothing survived and nothing is unmerged — the common "run finished, branch
  // landed, tree already reaped" shape. Bail before spending any more git calls.
  if (merged && !survivingTree) return null;

  // How many commits the branch holds that the default branch doesn't. Only ever
  // consulted on one of the two mutually exclusive paths below, so it costs a
  // single call per resolution.
  const commitsAhead = async () =>
    (await git.getBranchComparison(sourceWorkspace, target, branchName).catch(() => null))?.ahead || 0;

  // 1. Adopt the surviving tree — but only if it is actually on the branch we're
  //    resuming; a half-cleaned or repurposed directory must not be handed over.
  if (survivingTree && await git.getBranch(worktreePath).catch(() => null) === branchName) {
    if (!merged) {
      emitLog('info', `🌳 Worktree ${worktreePath} survived on unmerged ${branchName} — a retry can adopt it`, { branchName, worktreePath });
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
    if (!classifyWorktreeDirt(porcelain).hasRealChanges) return null;
    emitLog('info', `🌳 Worktree ${worktreePath} survived on ${branchName} — a retry can adopt it and keep its uncommitted work`, { branchName, worktreePath });
    return { branchName, worktreePath };
  }

  if (merged) return null;

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
  // Confirm the branch actually exists and holds commits — `isBranchMergedInto`
  // reports an ABSENT branch as unmerged, which would hand back a branch name no
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
export async function resolveTaskResumePatch({ task, agentId, agentMetadata }) {
  if (!task?.id || !agentId) return {};
  // Persistent feature-agent worktrees are never torn down, and throwaway
  // reasoning worktrees are deliberately discarded — neither leaves work to resume.
  // These runs are NOT evaluated at all, which is why they return the empty patch
  // rather than the clear: a task already resuming whose retry couldn't get a
  // worktree (see agentWorkspacePrep's degrade path) must KEEP its pointer, since
  // the tree it names is still sitting there for the attempt after this one.
  if (!agentMetadata?.isWorktree || agentMetadata?.isPersistentWorktree) return {};
  if (isTruthyMeta(task.metadata?.discardWorktree)) return {};

  // The agent's own recorded path is authoritative; the `<worktrees>/<agentId>`
  // convention is the fallback for a record written before it was stamped (same
  // idiom cleanupAgentWorktree uses for the PR push).
  const worktreePath = agentMetadata.workspacePath || join(PATHS.worktrees, agentId);
  const pointer = await resolveResumePointer(agentMetadata.sourceWorkspace, agentMetadata.worktreeBranch, worktreePath)
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
 * `existingBranch` is the flag agentWorkspacePrep already honors to attach a
 * worktree to a pre-existing branch (the review-loop follow-up uses it), and
 * `resumeWorktreePath` is honored there too, so resuming needs no new spawn
 * plumbing. `resumedFromAgentId` records whose run is being continued — it drives
 * the prompt's resume banner and is the marker that distinguishes a resume from
 * the follow-up (see `isPrBranchWorktree` in agentPromptBuilder.js).
 *
 * With no pointer, a previously-stamped resume is CLEARED: its branch may since
 * have been merged or deleted, and leaving the pointer would attach the next
 * attempt to landed work. Keyed on `resumedFromAgentId` so it only ever clears a
 * pointer this mechanism wrote — the review-loop follow-up's own `existingBranch`
 * is its whole reason for existing and must survive being orphaned.
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
  if (!task?.metadata?.resumedFromAgentId) return {};
  // `undefined`, not `null`: `updateTask` DELETES undefined keys from the merged
  // metadata, while a null survives the merge and TASKS.md serializes it as the
  // literal string `"null"` — which reads back as a truthy `existingBranch` and
  // sends the next attempt looking for a branch named "null". The keys are still
  // present on the returned patch, so callers can tell a clear from a no-op.
  return { existingBranch: undefined, resumedFromAgentId: undefined, resumeWorktreePath: undefined };
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
  if (!metadata.existingBranch) {
    emitLog('info', `🧹 Cleared spent resume pointer on task ${task.id} — nothing left to resume`, { taskId: task.id, agentId });
  }
  return metadata;
}

/**
 * The post-cleanup write that RELEASES a failed task's retry hold, shared by every
 * spawn mode (#3368, #3373).
 *
 * A failed agent whose branch — or whole worktree — survived cleanup leaves real
 * work behind (see `preserveBranchWithCommits` above; a dirty tree aborts removal
 * outright). Recording where it lives on the TASK is what makes its retry RESUME
 * rather than restart from scratch — the behavior the agent-d2ae0352 incident
 * exposed, where a run reaped 30s after its PR merged was re-dispatched to a fresh
 * agent that began the shipped work over.
 *
 * Call this AFTER `cleanupAgentWorktree` so it reflects what actually survived, and
 * from all three spawn sites — `spawnDirectly` (agentCliSpawning.js), the TUI
 * `finish()` (agentTuiSpawning.js), and `handleAgentCompletion`
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
 * `in_progress` without the marker (the retry already spawned), a failed read, a
 * task deleted mid-run — is not evidence of a retry, so we write nothing.
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
export async function releaseRetryHold({ agentId, task, success, agentMetadata }) {
  if (success || !agentId || !task?.id) return {};

  const { getTaskById, getAgentRecord } = await import('./cos.js');
  const persisted = await getTaskById(task.id).catch(err => {
    emitLog('warn', `Skipping resume pointer for task ${task.id} — status unreadable: ${err.message}`, { taskId: task.id, agentId });
    return null;
  });
  if (!persisted) return {};

  const held = isRetryHeld(persisted.metadata);
  // A record with no `status` at all is a legacy shape that predates the field;
  // those are pending.
  if (!held && (persisted.status ?? 'pending') !== 'pending') return {};

  const metadata = agentMetadata === undefined
    ? (await getAgentRecord(agentId).catch(() => null))?.metadata
    : agentMetadata;

  if (!held) return await recordTaskResumePointer({ task, agentId, agentMetadata: metadata });

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
  }, taskType).catch(err => {
    emitLog('warn', `Failed to release retry hold on task ${task.id}: ${err.message}`, { taskId: task.id, agentId });
    return { error: err.message };
  });
  if (result?.error) {
    // The hold is still on disk, so the orphan sweep finishes the transition —
    // the task is delayed, never stranded.
    emitLog('warn', `⏳ Task ${task.id} still held after a failed release — the orphan sweep will requeue it`, { taskId: task.id, agentId });
    return {};
  }
  emitLog('info', patch.existingBranch
    ? `🔁 Task ${task.id} requeued pointing at ${patch.existingBranch}`
    : `🔓 Task ${task.id} requeued for retry`, { taskId: task.id, agentId, branchName: patch.existingBranch || null });
  return patch;
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
 * The follow-up task uses an isolated worktree attached to the existing PR
 * branch (via createWorktree's `existingBranch` option) so it can fix-and-push
 * without trampling concurrent agents.
 */
export async function spawnReviewLoopFollowUp({ originalAgentId, originalTask, prUrl, prBranch, sourceWorkspace, prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, reviewerModels = null, leaveOpen = false }) {
  if (!prUrl || !prBranch) return null;
  if (prCompletion === PR_COMPLETIONS.LEAVE_OPEN) return null;

  const parsedPr = git.parsePullRequestUrl(prUrl);
  // Copilot is GitHub-only; CLI-based reviewers (claude/antigravity/codex/grok) work on any
  // forge because the agent invokes the CLI directly. On a GitLab forge, drop
  // copilot from the list. Classify with the shared detector rather than
  // `host !== 'github.com'` — a GitHub Enterprise host still has Copilot, and
  // misreading it as non-GitHub would strip the only reviewer and silently
  // downgrade the run to merge-only.
  const isNonGithubForge = !!parsedPr?.host && detectForgeCli(parsedPr.host) !== 'gh';
  // An EXPLICITLY empty list means "no review was requested" and must stay empty —
  // normalizeReviewers' `[copilot]` default would otherwise resurrect a reviewer.
  const reviewerList = (Array.isArray(reviewers) && reviewers.length === 0) ? [] : normalizeReviewers({ reviewers });
  const effectiveReviewers = isNonGithubForge ? reviewerList.filter(r => r !== DEFAULT_REVIEWER) : reviewerList;
  // GitHub reviewer usernames are forge-agnostic requested reviewers, so they are
  // NOT stripped on a non-GitHub forge — a username reviewer alone can drive the
  // loop even when copilot was dropped.
  const effectiveUsernames = normalizeReviewUsernames(usernames);
  // Non-blocking (`~opt`) marker set — forge-agnostic, threaded verbatim so the
  // follow-up's `--review-with` marks the same reviewers optional.
  const effectiveOptionalReviewers = normalizeOptionalReviewers(optionalReviewers) || [];
  // Per-reviewer iteration caps (`~max=<n>`) — forge-agnostic, threaded verbatim
  // so the follow-up's `--review-with` carries the same budgets. Entries for
  // reviewers that were stripped are inert (the emitter only marks tokens it
  // actually emits), so no narrowing is needed here.
  const effectiveReviewerMaxRounds = normalizeReviewerMaxRounds(reviewerMaxRounds) || {};
  // Merge-on-green deliberately skips every reviewer. A legacy review loop
  // whose GitHub-only reviewer vanishes on another forge retains its prior
  // merge-only fallback instead of leaving an orphaned PR.
  const mergeOnly = prCompletion === PR_COMPLETIONS.MERGE_ON_GREEN
    || (prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE
      && effectiveReviewers.length === 0 && effectiveUsernames.length === 0);
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
  const narrowedReviewerModels = {};
  for (const r of effectiveReviewers) {
    if (MODEL_SELECTABLE_REVIEWERS.includes(r) && reviewerModels?.[r]) narrowedReviewerModels[r] = reviewerModels[r];
  }

  // One place that names the mode, so the title, the log line, and the warning
  // can't drift apart as the two follow-up kinds evolve.
  const kind = mergeOnly
    ? { title: 'Merge', label: 'merge', reviewers: 'merge on green CI, no review' }
    : { title: 'Review Loop', label: 'review-loop', reviewers: [...effectiveReviewers, ...effectiveUsernames.map(u => `@${u}`)].join(', ') };

  // Inherit the source task's provider/model/effort pins. A follow-up runs a
  // coding harness (it fixes checks, resolves conflicts, drives reviewer CLIs),
  // so an install whose ACTIVE provider is api-only would permanently reject an
  // unpinned follow-up for lacking a harness — and the PR it was spawned to land
  // would sit open forever. Only copy what's actually pinned; an unpinned source
  // task still resolves through the normal active-provider path.
  //
  // The model pin rides ONLY with its provider: a bare `model` would be treated as
  // explicit against whatever provider resolution later picks, handing e.g. a
  // Claude model id to Codex. Effort is provider-agnostic, so it travels alone.
  const sourceMeta = originalTask?.metadata || {};
  const pinnedProvider = sourceMeta.provider || sourceMeta.providerId || null;
  const providerPins = {};
  if (pinnedProvider) {
    providerPins.provider = pinnedProvider;
    providerPins.providerId = pinnedProvider;
    if (sourceMeta.model) providerPins.model = sourceMeta.model;
  }
  if (sourceMeta.effort) providerPins.effort = sourceMeta.effort;

  const appId = originalTask?.metadata?.app || null;
  const sourceTaskDesc = originalTask?.description || 'CoS automated task';
  const firstLine = sourceTaskDesc.split(/[\r\n]/).find(l => l.trim()) || sourceTaskDesc;
  const followUpTitle = `[${kind.title}] ${firstLine.trim().substring(0, 80)} (${prUrl})`;

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
      // Merge-only run: no reviewers, the prompt is a CI-gate-and-merge procedure.
      reviewLoopMergeOnly: mergeOnly,
      // Review, but do NOT merge — the PR is a human's to land (JIRA hand-off).
      reviewLoopLeaveOpen: leaveOpen,
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
      reviewLoopOptionalReviewers: effectiveOptionalReviewers,
      // Per-reviewer `~max=<n>` caps, keyed by emitted token. Empty object = no
      // caps (leaves slashdo's per-loop built-in default in place); an absent key
      // is NOT `0`, which slashdo reads as "loop until clean".
      reviewLoopReviewerMaxRounds: effectiveReviewerMaxRounds,
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
  emitLog('info', `🔁 Spawned ${kind.label} follow-up task ${followUpTaskId} (${kind.reviewers}) for PR ${prUrl}`, {
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
