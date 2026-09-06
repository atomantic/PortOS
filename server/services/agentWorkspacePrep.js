/**
 * Agent Workspace Preparation
 *
 * Resolves the working directory an agent runs in and provisions any
 * isolation it needs before the agent is registered/spawned. Extracted from
 * `spawnAgentForTask` in agentLifecycle.js so that orchestrator stays
 * readable — this owns: workspace-path resolution, the pre-task git pull
 * (with conflict deferral), optional JIRA ticket + feature branch creation,
 * persistent feature-agent worktrees, and explicit/auto-detected worktree
 * creation.
 *
 * Side effects that don't touch spawn-local state (creating a conflict task,
 * flipping the task to pending/blocked, creating worktrees, mutating
 * `task.metadata` with JIRA fields) happen inline. Outcomes that the caller
 * must finish are returned as a discriminated result so the caller can fire
 * `cleanupOnError` + the matching `agent:deferred` / `agent:error` event:
 *
 *   { outcome: 'ready', workspacePath, resolvedAppName, worktreeInfo, jiraTicket, jiraBranchName, explicitWorktree }
 *   { outcome: 'deferred', reason, deferReason, branch }   // git conflict — task re-queued
 *   { outcome: 'blocked', reason }                          // explicit worktree requested but creation failed
 *                                                           // (`worktree-busy` blocks are a TIMED pause and revive themselves)
 *
 * An unexpected throw bubbles to the caller's widened try/catch the same way
 * the inline code did.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { execGit } from '../lib/execGit.js';
import { emitLog } from './cosEvents.js';
import { updateTask, addTask } from './cos.js';
import { getAppById } from './apps.js';
import { isTruthyMeta, isFalsyMeta, protectedAgentIds } from './agentState.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import * as git from './git.js';
import { detectConflicts } from './taskConflict.js';
import { createWorktree, adoptWorktree, findAdoptableWorktreeForBranch, isBranchCheckedOutElsewhereError } from './worktreeManager.js';
import { resolveSpawnCwd, usesCreativeDirectorScratchCwd, creativeDirectorScratchCwd } from '../lib/spawnCwd.js';
import { enforceSafeBranchUpstream } from '../lib/branchUpstreamGuard.js';
import { resolveTaskTargetBranch } from '../lib/taskTargetBranch.js';
import { resolveTaskForkHead } from '../lib/forkHead.js';
import { getAppWorkspace, getAppDataForTask, createJiraTicketForTask } from './agentPromptBuilder.js';
import { INVESTIGATION_TASK_DELIVERY, isInvestigationTask } from '../lib/investigationTasks.js';
import { isNonCommittingCoordinatorTask } from './taskTypeHooks.js';

const ROOT_DIR = PATHS.root;

/**
 * Park a task this module refuses to spawn, so the refusal is durable and
 * visible rather than a log line the scheduler reprints every tick.
 *
 * An un-persisted `blocked` outcome leaves the task `pending`: it is
 * re-dequeued, re-prepped and re-rejected forever, and the thing that would fix
 * it ("set the Repository Path in Apps") is only reachable from that task's own
 * log. Blocking puts it in the Blocked list carrying the instruction and leaves
 * it revivable once the config is fixed. Best-effort — the caller's block
 * outcome must stand even if the write fails.
 */
async function blockTask(task, reason, blockedCategory, extraMetadata = {}) {
  await updateTask(task.id, {
    status: 'blocked',
    metadata: {
      ...task.metadata,
      blockedReason: reason,
      blockedCategory,
      blockedAt: new Date().toISOString(),
      ...extraMetadata,
    },
  }, task.taskType || 'user').catch(() => {});
}

// How long a task waits for another worktree to release the branch it needs, and
// how many times it may wait. The producer of that contention is a cleanup
// tearing down the previous agent's worktree, which finishes in seconds — but a
// worktree `removeWorktree` REFUSED to delete (uncommitted changes) holds the
// branch until a human clears it, so the wait has to be bounded. Past the cap the
// task takes the ordinary `worktree-failed` block and the orphaned-PR notifier
// raises its card.
const WORKTREE_BUSY_COOLDOWN_MS = 2 * 60 * 1000;
const WORKTREE_BUSY_MAX_ATTEMPTS = 5;

// Compatibility export for callers that reached for the accessor from this
// service before the shared task-target-branch contract existed.
export { resolveTaskTargetBranch as resolveTaskExistingBranch } from '../lib/taskTargetBranch.js';

/** `protectedAgentIds` over a freshly-read agent list — see agentState.js. */
async function getProtectedAgentIds() {
  const { getAgents } = await import('./cos.js');
  return protectedAgentIds(await getAgents());
}

/**
 * Take over the worktree that already holds `branchName`, for a task whose whole
 * purpose is to run ON that branch (a merge/review-loop follow-up, a resume).
 *
 * Resolved before `createWorktree`, so both a resume and a review-loop follow-up
 * share one answer to "which tree holds this branch?". Routinely that holder is a
 * cleanup's tree seconds from teardown, but a tree `removeWorktree` REFUSED to
 * delete (uncommitted changes) holds the branch until a human intervenes. Adoption
 * is the shorter path in both cases and preserves whatever the previous run left
 * behind.
 *
 * `findAdoptableWorktreeForBranch` refuses every holder PortOS doesn't own
 * outright, so this can never move the user's checkout or a live agent's tree.
 * The one caller-gated exception is `allowLiveClaim`: a non-committing
 * coordinator follow-up (`isNonCommittingCoordinatorTask` — a review-loop
 * resolve-and-merge or a PR-remediation follow-up) may take over a `claim-*`
 * holder too, because its whole deliverable names that exact branch as the one
 * to finish and land.
 *
 * @returns {Promise<{ worktreeInfo: object, adoptedFrom: string }|null>}
 */
async function adoptWorktreeHoldingBranch({ agentId, workspacePath, branchName, preferredPath = null, taskId, allowLiveClaim = false }) {
  // Fail CLOSED on an unreadable agent list: an empty protected set would read as
  // "nothing is running", which is the one wrong answer here — it would move a
  // live run's directory. The caller's timed pause is the safe outcome instead.
  const activeAgentIds = await getProtectedAgentIds().catch(err => {
    emitLog('warn', `🌳 Skipping worktree adoption for task ${taskId} — could not read the agent list: ${err.message}`, { taskId });
    return null;
  });
  if (!activeAgentIds) return null;

  const holder = await findAdoptableWorktreeForBranch(workspacePath, branchName, { activeAgentIds, preferredPath, allowLiveClaim });
  if (!holder) return null;

  const worktreeInfo = await adoptWorktree(agentId, workspacePath, holder.path, branchName).catch(err => {
    emitLog('warn', `🌳 Could not adopt ${holder.path} holding ${branchName} for task ${taskId}: ${err.message}`, { taskId });
    return null;
  });
  return worktreeInfo ? { worktreeInfo, adoptedFrom: holder.agentId } : null;
}

/**
 * Provision a worktree that the task explicitly needs, including a safe
 * adoption of a surviving branch holder. This is shared by read-only public
 * review stages and ordinary delivery agents: read-only describes what the
 * model may do inside the tree, not whether the tree itself may be shared with
 * the live checkout.
 */
async function prepareRequestedWorktree({
  agentId,
  workspacePath,
  task,
  existingBranch,
  forkHead,
  allowSharedWorkspaceFallback,
}) {
  // Detecting the base branch and resolving the branch holder are independent
  // reads (a git-branches lookup vs. an agent-liveness + worktree-list check) —
  // kick both off before awaiting either so their I/O overlaps instead of
  // serializing on the spawn hot path.
  const detectedBasePromise = git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
  // Resolve the branch holder ONCE before creation. `resumeWorktreePath` is a
  // cache of that answer, not a separate ownership rule: if it is gone or
  // stale, discovery finds the actual holder. This gives resume retries the
  // same safe adoption path review-loop follow-ups use, rather than cutting a
  // fresh branch merely because a cached path could not be moved.
  const resumeWorktreePath = existingBranch ? task.metadata?.resumeWorktreePath : null;
  // A review-loop / PR-remediation follow-up's whole purpose is landing THIS
  // branch, and the user's own "resolve and merge" trigger (or pr-reviewer's own
  // dispatch) is the signal to finish whatever a `/do:next` claim left on it — so
  // these are the callers allowed to take over a `claim-*` holder instead of
  // retrying against it until the task gives up (#6243). `isNonCommittingCoordinatorTask`
  // is the shared predicate for exactly this "same shape" set (taskTypeHooks.js) —
  // reused here rather than re-listing the flags, so a future follow-up type of the
  // same shape inherits the carve-out too. A plain resume never targets a claim tree
  // (its pointer names a CoS `agent-*` worktree) and doesn't set either follow-up
  // flag, so the predicate is a no-op there.
  const takeoverPromise = existingBranch
    ? adoptWorktreeHoldingBranch({
      agentId,
      workspacePath,
      branchName: existingBranch,
      preferredPath: resumeWorktreePath,
      taskId: task.id,
      allowLiveClaim: isNonCommittingCoordinatorTask(task),
    })
    : Promise.resolve(null);

  const { baseBranch: detectedBase } = await detectedBasePromise;
  if (existingBranch) {
    emitLog('info', `🌳 Worktree requested for task ${task.id} on existing branch ${existingBranch}`, {
      taskId: task.id, app: task.metadata?.app, branch: existingBranch
    });
  } else {
    emitLog('info', `🌳 Worktree requested for task ${task.id} — creating isolated worktree from ${detectedBase || 'default branch'}`, {
      taskId: task.id, app: task.metadata?.app, baseBranch: detectedBase
    });
  }

  const takeover = await takeoverPromise;

  // Both read only by the block/pause decision below: the failure REASON
  // decides whether the task is unrunnable or merely early, and `attempt` is
  // which branch-busy wait this would be (TASKS.md round-trips metadata as
  // strings, hence the coercion; never reset on revive, so the cap is the
  // task's whole patience budget rather than a per-attempt one).
  let worktreeError = null;
  const attempt = (Number(task.metadata?.worktreeBusyAttempts) || 0) + 1;
  const worktreeInfo = takeover?.worktreeInfo || await createWorktree(agentId, workspacePath, task.id, {
    baseBranch: detectedBase || undefined,
    existingBranch: existingBranch || undefined,
    // Only consulted when `existingBranch` names a FORK PR's head, which has no
    // `origin/<branch>` to attach to (#6064). Null for every other task, which
    // is the behavior that predates it.
    forkHead: forkHead || undefined,
    planId: task.metadata?.planId || undefined
  }).catch(err => {
    worktreeError = err;
    emitLog('warn', `🌳 Worktree creation failed for task ${task.id}: ${err.message}`, { taskId: task.id });
    return null;
  });

  if (worktreeInfo) {
    const nextWorkspacePath = worktreeInfo.worktreePath;
    const origin = worktreeInfo.adopted
      ? `adopted from ${takeover?.adoptedFrom || task.metadata?.resumedFromAgentId || 'the interrupted run'}`
      : `base: ${worktreeInfo.baseBranch}`;
    emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName} (${origin})`, {
      agentId, worktreePath: nextWorkspacePath, branchName: worktreeInfo.branchName, baseBranch: worktreeInfo.baseBranch
    });
    return { outcome: 'ready', workspacePath: nextWorkspacePath, worktreeInfo };
  }

  if (allowSharedWorkspaceFallback) {
    // Reached here only for a resume pointer on a task that never asked for
    // isolation. Blocking would be STRICTER than the task's own contract — it
    // would have run in the shared workspace before the pointer existed — so
    // degrade to that instead. The resume is lost (the leftover work stays on
    // disk for the next attempt), but the task still runs.
    emitLog('warn', `🌳 Worktree creation failed for task ${task.id}; resuming is not possible, continuing in the shared workspace`, { taskId: task.id });
    return { outcome: 'ready', workspacePath, worktreeInfo: null };
  }

  if (isBranchCheckedOutElsewhereError(worktreeError?.message) && attempt <= WORKTREE_BUSY_MAX_ATTEMPTS) {
    // The branch is checked out in ANOTHER worktree. Routinely that other
    // worktree is the previous agent's, still being torn down by the very
    // cleanup that spawned this task, so waiting it out lands the pull
    // request a permanent block would have stranded. `worktree-busy` is a
    // TIMED PAUSE (lib/taskBlockCategories.js): the cooldown sweeper revives
    // it, and the pause keeps `existingBranch` so the revived attempt still
    // attaches to the PR branch instead of cutting a fresh one off main.
    const reason = `Branch ${existingBranch || 'for this task'} is still checked out in another worktree; retrying after a short cooldown`;
    emitLog('info', `🌳 ${reason} (attempt ${attempt}/${WORKTREE_BUSY_MAX_ATTEMPTS})`, { taskId: task.id, branch: existingBranch || null });
    await blockTask(task, `${reason}. ${worktreeError?.message || ''}`.trim(), 'worktree-busy', {
      cooldownUntil: new Date(Date.now() + WORKTREE_BUSY_COOLDOWN_MS).toISOString(),
      worktreeBusyAttempts: attempt,
    });
    return { outcome: 'blocked', reason };
  }

  // Isolation was explicitly requested (or is required to reach an existing
  // branch), so falling back to the shared workspace would run the agent
  // against the live checkout. Fail closed: block the task rather than touch
  // the working tree behind the user's back.
  const reason = `Worktree creation failed for task ${task.id}; refusing to run in the shared workspace because isolation was required`;
  emitLog('warn', `🌳 ${reason}`, { taskId: task.id });
  await blockTask(task, `Worktree creation failed — isolation was required${worktreeError?.message ? `: ${worktreeError.message}` : ''}`, 'worktree-failed');
  return { outcome: 'blocked', reason };
}

/**
 * Prepare the workspace (and any worktree/JIRA branch) for an agent task.
 *
 * @param {{ agentId: string, task: object }} params
 * @returns {Promise<object>} discriminated outcome (see module doc)
 */
export async function prepareAgentWorkspace({ agentId, task }) {
  // Creative Director treatment/plan/evaluate tasks are HTTP-PATCH deliverables
  // and never asked for a worktree. Pin them to an isolated scratch cwd BEFORE
  // the PortOS-root resolution / git-pull / conflict scan, so a CLI/TUI provider
  // cannot natively discover the repo AGENTS.md tree (#4650).
  if (usesCreativeDirectorScratchCwd(task)) {
    const workspacePath = creativeDirectorScratchCwd(agentId);
    await ensureDir(workspacePath);
    // Codex (and any CLI that refuses a non-git cwd) needs a repo root here.
    // Initializing INSIDE the scratch makes the scratch itself the git root, so
    // native AGENTS.md discovery cannot walk up into the PortOS checkout —
    // `--skip-git-repo-check` would only cover Codex's exec path, not TUI.
    await execGit(['init'], workspacePath).catch((err) => {
      emitLog('warn', `⚠️ CD scratch git init failed for ${agentId}: ${err.message}`, {
        taskId: task.id, workspace: workspacePath,
      });
    });
    emitLog('info', `📂 Agent workspace: ${workspacePath} (creative-director scratch)`, {
      taskId: task.id, workspace: workspacePath,
    });
    return {
      outcome: 'ready',
      workspacePath,
      resolvedAppName: null,
      worktreeInfo: null,
      jiraTicket: null,
      jiraBranchName: null,
      explicitWorktree: false,
    };
  }

  // Pre-change investigation tasks may already be persisted without delivery
  // flags. Normalize them at the last common spawn boundary so an old queued
  // investigation cannot fall back to committing in the shared checkout.
  if (isInvestigationTask(task)) {
    task.metadata = { ...(task.metadata || {}), ...INVESTIGATION_TASK_DELIVERY };
  }

  // Determine workspace path and resolve app name
  const isReadOnly = isTruthyMeta(task.metadata?.readOnly);
  let workspacePath = task.metadata?.app
    ? await getAppWorkspace(task.metadata.app)
    : ROOT_DIR;
  const resolvedAppName = task.metadata?.app
    ? (await getAppById(task.metadata.app).catch(() => null))?.name || null
    : null;

  // Refuse to run an agent whose app didn't resolve to a usable directory.
  // Previously both failures fell through to the PortOS root and the agent
  // silently did its work in the PortOS checkout instead of the user's app
  // (issue #3180) — a wrong-repo commit is far worse than a blocked task, and
  // the block carries the exact thing to fix. Validated ONCE here rather than in
  // each of the three spawn helpers (TUI / runner / direct), which all take
  // their cwd from this function.
  if (task.metadata?.app && !workspacePath) {
    // The reason line is now the whole Blocked card, so it has to cover both
    // ways this resolves to nothing: the app is registered but carries no
    // Repository Path, OR nothing in Apps matches that id/name at all (the
    // shape a task gets when a producer used `app` as a feature tag rather
    // than as routing — see migration 234).
    const reason = `App '${task.metadata.app}' didn't resolve to a repository directory — it must name an app in Apps `
      + `that has a Repository Path set. Fix the app (or clear it from the task), then re-run this task. `
      + `(The agent was not started, so it could not write into the PortOS directory by mistake.)`;
    emitLog('error', `❌ ${reason}`, { taskId: task.id });
    await blockTask(task, reason, 'app-unresolved');
    return { outcome: 'blocked', reason };
  }
  // Same resolver the /runs spawn paths use, so a `~/Projects/App` repoPath
  // expands here too and a repoPath pointing at a FILE is rejected up front
  // rather than flowing into the git operations below with a non-directory cwd.
  // Reusing it is what keeps the two validation sites from drifting — an
  // inline existsSync here did both of those wrong.
  try {
    workspacePath = resolveSpawnCwd(workspacePath, ROOT_DIR, `Task ${task.id}`);
  } catch (err) {
    const reason = `${err.message} (Task blocked before the agent started, so it could not write into the PortOS directory by mistake.)`;
    emitLog('error', `❌ ${reason}`, { taskId: task.id, workspace: workspacePath });
    // A task with no `app` lands here only if the PortOS root itself is
    // unusable, which is a different problem than a mis-configured app record —
    // don't file it under the app category.
    await blockTask(task, reason, task.metadata?.app ? 'app-unresolved' : 'workspace-invalid');
    return { outcome: 'blocked', reason };
  }

  let jiraTicket = null;
  let jiraBranchName = null;
  let worktreeInfo = null;
  const explicitOpenPR = isTruthyMeta(task.metadata?.openPR);
  const explicitWorktree = isTruthyMeta(task.metadata?.useWorktree) || explicitOpenPR;
  // A task pointed at an existing branch must run in a worktree whatever isolated
  // the ORIGINAL run, because that is the only way to reach the work: the branch
  // has to be checked out somewhere, and an adoptable tree has to be attached.
  // Keyed on `existingBranch` so it covers both producers — a resume pointer and
  // the review-loop follow-up. Without it, a run that got its worktree from
  // conflict AUTO-detection resumes into the shared workspace on retry (conflict
  // detection returns `proceed` once the dead agent is gone) and silently
  // abandons the work the pointer was recorded to save.
  const existingBranch = resolveTaskTargetBranch(task.metadata);
  // Where that branch lives when the task points at a fork PR's head — read
  // here rather than inside the worktree layer, which has no forge client.
  const forkHead = resolveTaskForkHead(task.metadata);
  const wantsWorktree = explicitWorktree || !!existingBranch;

  if (!isReadOnly) {
    // Pull latest from git before starting work
    const pullResult = await git.ensureLatest(workspacePath).catch(err => {
      emitLog('warn', `⚠️ Pre-task git pull failed for ${workspacePath}: ${err.message}`, { taskId: task.id, workspace: workspacePath });
      return { success: false, error: err.message };
    });

    if (pullResult.skipped) {
      emitLog('debug', `Pre-task git pull skipped: ${pullResult.skipped}`, { taskId: task.id, workspace: workspacePath });
    } else if (pullResult.conflict) {
      emitLog('warn', `🔀 Git conflict in ${workspacePath} (branch: ${pullResult.branch}): ${pullResult.error}`, {
        taskId: task.id, workspace: workspacePath, branch: pullResult.branch
      });

      const appId = task.metadata?.app || null;
      const conflictDesc = `Resolve git conflict in ${resolvedAppName || workspacePath} on branch ${pullResult.branch}. `
        + `The branch has diverged from origin and automatic rebase failed. `
        + `Error: ${pullResult.error}`;

      await addTask({
        description: conflictDesc,
        priority: 'HIGH',
        app: appId,
        context: `This conflict is blocking task ${task.id}: "${task.description}". `
          + `Resolve the conflict, commit, and push so the blocked task can proceed.`,
        position: 'top'
      }, 'internal').catch(err => {
        emitLog('warn', `Failed to create conflict resolution task: ${err.message}`, { taskId: task.id });
      });

      await updateTask(task.id, { status: 'pending' }, task.taskType || 'user').catch(() => {});
      return {
        outcome: 'deferred',
        reason: 'Git conflict blocks task — conflict resolution task created',
        deferReason: 'git-conflict',
        branch: pullResult.branch
      };
    } else if (pullResult.success && !pullResult.upToDate && !pullResult.skipped) {
      emitLog('info', `📥 Pulled latest for ${resolvedAppName || 'workspace'} (branch: ${pullResult.branch})`, {
        taskId: task.id, workspace: workspacePath, branch: pullResult.branch
      });
    } else if (!pullResult.success) {
      emitLog('warn', `⚠️ Pre-task git pull error: ${pullResult.error}`, { taskId: task.id, workspace: workspacePath });
    }

    // JIRA integration: create ticket + feature branch if app has JIRA enabled and task opted in
    const appData = await getAppDataForTask(task);

    if (appData?.jira?.enabled && task.metadata?.createJiraTicket) {
      jiraTicket = await createJiraTicketForTask(task, appData);

      if (jiraTicket) {
        const slug = (task.description || 'task')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 40);
        jiraBranchName = `feature/${jiraTicket.ticketId}-${slug}`;

        if (task.metadata?.app) {
          await git.fetchOrigin(workspacePath).catch(() => {});
          const { baseBranch: defaultBranch } = await git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
          if (defaultBranch) {
            await git.checkout(workspacePath, defaultBranch).catch(() => {});
            await execGit(['merge', '--ff-only', `origin/${defaultBranch}`], workspacePath).catch(err => { emitLog('warn', `Fast-forward merge of ${defaultBranch} failed: ${err.message}`, { taskId: task.id }); });
          }
        }

        await git.createBranch(workspacePath, jiraBranchName)
          // `checkout -b` off a LOCAL branch doesn't auto-track under git's default
          // `branch.autoSetupMerge`, but a repo configured `always` records the base
          // branch as this one's upstream — and a config-derived push
          // (`git push <remote> HEAD:<merge>`) then lands the agent's work on the base
          // branch instead of opening a PR (#4172). Verify before handing it over.
          .then(() => enforceSafeBranchUpstream(workspacePath, jiraBranchName))
          .catch(err => {
            emitLog('warn', `Failed to create JIRA branch ${jiraBranchName}: ${err.message}`, { taskId: task.id });
            jiraBranchName = null;
          });

        if (jiraBranchName) {
          emitLog('success', `Created feature branch ${jiraBranchName}`, { taskId: task.id, ticketId: jiraTicket.ticketId });
        }

        task.metadata = {
          ...task.metadata,
          jiraTicketId: jiraTicket.ticketId,
          jiraTicketUrl: jiraTicket.ticketUrl,
          jiraBranch: jiraBranchName,
          jiraInstanceId: appData.jira.instanceId,
          jiraCreatePR: appData.jira.createPR !== false
        };
      }
    }

    // Feature agent tasks: use persistent worktree instead of creating a new one
    if (task.metadata?.featureAgentRun && task.metadata?.featureAgentId) {
      const { getFeatureAgent } = await import('./featureAgents.js');
      const fa = await getFeatureAgent(task.metadata.featureAgentId).catch(() => null);
      if (fa) {
        const faWorktreePath = join(PATHS.cos, 'feature-agents', fa.id, 'worktree');
        if (existsSync(faWorktreePath)) {
          workspacePath = faWorktreePath;
          worktreeInfo = {
            worktreePath: faWorktreePath,
            branchName: fa.git.branchName,
            baseBranch: fa.git.baseBranch || 'main',
            isPersistentWorktree: true
          };
          const { mergeBaseIntoFeatureWorktree } = await import('./worktreeManager.js');
          if (fa.git.autoMergeBase) {
            await mergeBaseIntoFeatureWorktree(fa.id, fa.git.baseBranch).catch(err => {
              emitLog('warn', `🌳 Feature agent base merge failed: ${err.message}`, { featureAgentId: fa.id });
            });
          }
          emitLog('info', `🌳 Feature agent ${fa.name} using persistent worktree: ${fa.git.branchName}`, {
            featureAgentId: fa.id, worktreePath: faWorktreePath
          });
        }
      }
    }

  } // end !isReadOnly

  // A read-only public-review stage still needs a disposable checkout: it may
  // run repository commands and the action stage's provider-specific sandbox
  // needs it for tests/patch inspection. Never let `readOnly` turn an explicit
  // isolation request into the live application checkout.
  if (wantsWorktree && !jiraBranchName) {
    const worktreeOutcome = await prepareRequestedWorktree({
      agentId,
      workspacePath,
      task,
      existingBranch,
      forkHead,
      allowSharedWorkspaceFallback: !isReadOnly && !explicitWorktree,
    });
    if (worktreeOutcome.outcome !== 'ready') return worktreeOutcome;
    workspacePath = worktreeOutcome.workspacePath;
    worktreeInfo = worktreeOutcome.worktreeInfo;
  } else if (!isReadOnly && !jiraBranchName && !isFalsyMeta(task.metadata?.useWorktree)) {
      const { getAgents } = await import('./cos.js');
      const allAgents = await getAgents();
      const runningAgents = allAgents.filter(a => a.status === 'running');

      const conflictResult = await detectConflicts(task, workspacePath, runningAgents).catch(err => {
        emitLog('warn', `Conflict detection failed: ${err.message}`, { taskId: task.id });
        return { hasConflict: false, recommendation: 'proceed' };
      });

      if (conflictResult.recommendation === 'worktree') {
        emitLog('info', `🌳 Conflict detected for task ${task.id}: ${conflictResult.reason} — creating worktree`, {
          taskId: task.id,
          conflictingAgents: conflictResult.conflictingAgents,
          reason: conflictResult.reason
        });

        worktreeInfo = await createWorktree(agentId, workspacePath, task.id, {
          planId: task.metadata?.planId || undefined
        }).catch(err => {
          emitLog('warn', `🌳 Worktree creation failed, using shared workspace: ${err.message}`, { taskId: task.id });
          return null;
        });

        if (worktreeInfo) {
          workspacePath = worktreeInfo.worktreePath;
          emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName}`, {
            agentId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName
          });
        }
      } else if (conflictResult.recommendation === 'proceed') {
        emitLog('debug', `No conflicts for task ${task.id}, using shared workspace`, { taskId: task.id });
      }
    }

  // Announce the FINAL cwd — emitted here, after any worktree reassignment
  // above, so the task log names the directory the agent actually runs in
  // rather than the repo it was cut from (#3180).
  emitLog('info', `📂 Agent workspace: ${workspacePath}`, { taskId: task.id, workspace: workspacePath });

  return {
    outcome: 'ready',
    workspacePath,
    resolvedAppName,
    worktreeInfo,
    jiraTicket,
    jiraBranchName,
    explicitWorktree
  };
}
