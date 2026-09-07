/**
 * Agent Completion Cleanup
 *
 * The post-finalize orchestration that runs after `finalizeAgent`, for every
 * path a CoS run can complete on:
 *
 *   - `runAgentCompletionCleanup` — the runner-event path (`handleAgentCompletion`
 *     in agentLifecycle.js): JIRA branch push + PR + ticket comment, the
 *     plan-question notification marker, pipeline-stage progression, the
 *     Creative Director chain hook, and worktree cleanup (with cleanup-warning
 *     notifications + merge-recovery task). Extracted from agentLifecycle.js to
 *     keep `handleAgentCompletion`'s try/finally guard small and obvious.
 *   - `runSpawnerCompletionCleanup` — the two in-process spawners, whose child
 *     process (or PTY relay) this server owns: the TUI `finish()` handler
 *     (agentTuiSpawning.js) and the direct-CLI `close` handler
 *     (agentCliSpawning.js). Pipeline progression, worktree cleanup with the PR
 *     disposition, and the retry-hold release.
 *
 * Both hand `cleanupAgentWorktree` the options `resolveWorktreeCleanupOptions`
 * builds, so the PR-disposition shape has one owner. `handlePipelineProgression`
 * lives here too — it's only invoked from these cleanup flows (agentLifecycle.js
 * re-exports it for subAgentSpawner).
 *
 * This module imports the worktree-cleanup leaf (agentWorktreeCleanup.js)
 * directly; it must NOT import from agentLifecycle.js, which imports this
 * module — that would form a cycle. Nothing in this module's static closure
 * reaches agentLifecycle.js or either spawner, which is what lets the spawners
 * import it at top level.
 */

import { join, relative, resolve, sep } from 'path';
import { unlink, rm } from 'fs/promises';
import { emitLog } from './cosEvents.js';
import { updateAgent } from './cosAgentLifecycle.js';
import { updateTask, addTask, reviveBlockedTask, checkStagePrecondition } from './cos.js';
import { PIPELINE_STAGE_BEHAVIOR_FLAGS, normalizeReviewers } from '../lib/validation.js';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import * as jiraService from './jira.js';
import * as git from './git.js';
import { isTruthyMeta } from './agentState.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { cleanupAgentWorktree, spawnMergeRecoveryTask, releaseRetryHold } from './agentWorktreeCleanup.js';
import { PR_CREATION, resolvePrCompletion, resolvePrCreation } from '../lib/prDisposition.js';
import { resolveOwnsPrWorkflow } from '../lib/slashdoInvocation.js';
import { isPublicReviewRestrictedProfile, publicReviewPostureForProfile } from '../lib/agentExecutionProfiles.js';

const ROOT_DIR = PATHS.root;

/**
 * Advance a pipeline to its next stage after the current stage completes.
 * Creates a new task for the next stage or marks the pipeline as complete/failed.
 */
export async function handlePipelineProgression(task, agentId, success) {
  const pipeline = task.metadata?.pipeline;
  if (!pipeline || pipeline.status !== 'running') return;

  const { currentStage, stages } = pipeline;
  const stageResult = {
    stage: currentStage,
    name: stages[currentStage]?.name,
    agentId,
    success,
    completedAt: new Date().toISOString()
  };
  const updatedResults = [...(pipeline.stageResults || []), stageResult];

  if (!success) {
    await updateTask(task.id, {
      metadata: { ...task.metadata, pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
    }, task.taskType);
    emitLog('warn', `⛔ Pipeline ${pipeline.id} failed at stage ${currentStage}: ${stages[currentStage]?.name}`, { pipelineId: pipeline.id });
    return;
  }

  const nextStageIndex = currentStage + 1;
  if (nextStageIndex >= stages.length) {
    await updateTask(task.id, {
      metadata: { ...task.metadata, pipeline: { ...pipeline, status: 'completed', stageResults: updatedResults } }
    }, task.taskType);
    // Clean up pipeline artifacts (e.g., REVIEW.md left by stage 1)
    if (task.metadata.repoPath) {
      const repoRoot = resolve(task.metadata.repoPath);
      for (const stage of stages) {
        const file = stage.precondition?.fileNotExists;
        if (file) {
          const filePath = resolve(repoRoot, file);
          const rel = relative(repoRoot, filePath);
          if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(rel) === rel) continue;
          await unlink(filePath).catch(() => {});
        }
      }
    }
    emitLog('info', `✅ Pipeline ${pipeline.id} completed all ${stages.length} stages`, { pipelineId: pipeline.id });
    return;
  }

  const nextStage = stages[nextStageIndex];

  // A restricted execution profile must never be INHERITED across a stage
  // boundary — the profile is what selects the provider posture and the
  // stripped child environment, so carrying the previous stage's value would
  // run the next stage under the wrong contract (or, if cleared, under none at
  // all while still holding untrusted public content). A pipeline that has
  // entered a restricted profile and whose next stage declares none fails
  // closed rather than handing that content to an unrestricted agent.
  if (isPublicReviewRestrictedProfile(task.metadata?.executionProfile) && !nextStage.executionProfile) {
    await updateTask(task.id, {
      metadata: { ...task.metadata, pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
    }, task.taskType);
    emitLog('warn', `⛔ Pipeline ${pipeline.id} stage ${nextStageIndex} declares no execution profile after a restricted stage`, { pipelineId: pipeline.id });
    return;
  }

  // Check next stage's precondition before advancing
  if (nextStage.precondition && task.metadata.repoPath) {
    const check = checkStagePrecondition(nextStage, task.metadata.repoPath);
    if (!check.passed) {
      await updateTask(task.id, {
        metadata: { ...task.metadata, pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
      }, task.taskType);
      emitLog('warn', `⏭️ Pipeline ${pipeline.id} stage ${nextStageIndex} precondition failed: ${check.reason}`, { pipelineId: pipeline.id });
      return;
    }
  }

  const { getStagePrompt } = await import('./taskPromptService.js');
  let prompt = await getStagePrompt(task.metadata.analysisType, nextStageIndex);
  if (task.metadata.appName) prompt = prompt.replace(/\{appName\}/g, task.metadata.appName);
  if (task.metadata.repoPath) prompt = prompt.replace(/\{repoPath\}/g, task.metadata.repoPath);
  if (task.metadata.app) prompt = prompt.replace(/\{appId\}/g, task.metadata.app);

  const nextTask = {
    id: `${task.id || 'sys-pipeline'}-stage${nextStageIndex}-${Date.now().toString(36)}`,
    status: 'pending',
    description: prompt,
    priority: task.priority || 'MEDIUM',
    metadata: {
      ...task.metadata,
      readOnly: nextStage.readOnly ?? false,
      pipeline: {
        ...pipeline,
        currentStage: nextStageIndex,
        stageResults: updatedResults,
        previousStageAgentId: agentId,
        status: 'running'
      }
    },
    autoApproved: true
  };
  // Provider/model/effort are SET-only (never cleared) on hand-off: a stage
  // without its own pin inherits the value carried in `...task.metadata` — either
  // the task-level pin (interval config) or the prior stage's. Clearing an unset
  // stage's effort here would wipe a task-level effort from stage 1+.
  //
  // A public-review stage is the exception: its provider is resolved against
  // the posture it declares, and the stages have different postures — the
  // eligibility gate is typically pinned to a small tool-free local model that
  // must never be inherited by the sandboxed review stage. An unpinned
  // public-review stage means "first eligible provider on this install" (what
  // the schedule UI promises), so the previous stage's pins are dropped here.
  if (publicReviewPostureForProfile(nextStage.executionProfile)) {
    for (const key of ['provider', 'providerId', 'model', 'effort']) delete nextTask.metadata[key];
  }
  // The previous stage's agent payload must not travel: `description` above IS
  // this stage's prompt, and addTask only promotes it to `metadata.prompt` when
  // none is set — an inherited one made every stage after the first run on the
  // stage before it's instructions.
  delete nextTask.metadata.prompt;
  if (nextStage.model) nextTask.metadata.model = nextStage.model;
  if (nextStage.providerId) {
    nextTask.metadata.provider = nextStage.providerId;
    nextTask.metadata.providerId = nextStage.providerId;
  }
  if (nextStage.effort) nextTask.metadata.effort = nextStage.effort;
  // The profile, unlike the pins above, is SET-OR-CLEARED (see the guard at the
  // top of the hand-off): each stage runs under exactly the contract it
  // declares, never the previous stage's.
  nextTask.metadata.executionProfile = nextStage.executionProfile || null;
  // Apply per-stage overrides for agent behavior flags
  const stageReadOnly = nextStage.readOnly ?? false;
  const taskDefaults = pipeline.taskDefaults || {};
  for (const flag of PIPELINE_STAGE_BEHAVIOR_FLAGS) {
    if (flag in nextStage) {
      nextTask.metadata[flag] = nextStage[flag];
    } else if (stageReadOnly) {
      nextTask.metadata[flag] = false;
    } else if (flag in taskDefaults) {
      nextTask.metadata[flag] = taskDefaults[flag];
    }
  }

  const persisted = await addTask(nextTask, 'internal', { raw: true });
  if (persisted?.duplicate) {
    // A stage prompt interpolates only app fields, so two runs of the same
    // pipeline produce identical first lines — and addTask's dedup also matches
    // blocked tasks (#2614). A stale blocked stage task from an earlier run
    // would otherwise silently swallow this advance (nothing reaps blocked
    // tasks), wedging every future run of the pipeline. Revive it with the
    // fresh stage payload — the retry path is unblocking the existing task,
    // not minting a duplicate. reviveBlockedTask clears the blocked metadata
    // and retry budgets and merges in the new pipeline state.
    if (persisted.status === 'blocked') {
      await reviveBlockedTask(persisted.id, {
        priority: nextTask.priority,
        metadata: nextTask.metadata
      }, 'internal');
      emitLog('info', `🔗 Pipeline ${pipeline.id} advancing to stage ${nextStageIndex} by reviving blocked task ${persisted.id}: ${nextStage.name}`, { pipelineId: pipeline.id, agentId });
      return;
    }
    emitLog('warn', `⚠️ Pipeline ${pipeline.id} stage ${nextStageIndex} already queued as ${persisted.id} (${persisted.status}) — skipping duplicate advance`, { pipelineId: pipeline.id, agentId });
    return;
  }
  emitLog('info', `🔗 Pipeline ${pipeline.id} advancing to stage ${nextStageIndex}: ${nextStage.name}`, { pipelineId: pipeline.id, agentId });
}

/**
 * The options `cleanupAgentWorktree` decides a completing run's PR on — who
 * opens it (`prCreation`), how it lands (`prCompletion`), which reviewers gate
 * it, and whether the worktree branch may auto-merge — resolved from the task
 * and the caller's PR-ownership verdict. ONE owner for the shape, shared by the
 * runner-event path (`runCompletionCleanupSteps`) and both in-process spawners
 * (`runSpawnerCompletionCleanup`). It used to be three inline copies, and the
 * reviewer-resolve hardening below reached only one of them.
 *
 * `taskOpenPR` / `agentOwnsPR` are the CALLER's: the spawners read them off the
 * live provider descriptor (`resolvePrOwnership`), the runner path off the
 * persisted agent record (`resolveOwnsPrWorkflow`) — see #3358 for why the two
 * sources exist. `prClaimVerified` likewise carries whether finalize's check
 * ACTUALLY produced a forge answer for this run, which is a different question
 * from whether one was expected.
 *
 * Only the two `prCreation` modes that can still open a PR (and thus spawn a
 * follow-up that needs reviewer options) pay for the reviewer resolve. `never`
 * — the dominant path, a harness that opened and landed its own PR — discards
 * them, and a resolve that throws degrades to the follow-up's defaults rather
 * than skipping the worktree cleanup this runs inside of.
 *
 * @returns {Promise<Object>} the third argument to `cleanupAgentWorktree`
 */
async function resolveWorktreeCleanupOptions({ agentId, task, outputBuffer, taskOpenPR, agentOwnsPR, prClaimVerified = false, noChangesToShip = false }) {
  // `if-missing` for an agent-owned PR that finalize did NOT verify: cleanup
  // asks the forge once and only stands down when a PR actually exists, so a
  // harness that skipped its completion workflow can't strand the branch.
  const prCreation = resolvePrCreation({ taskOpenPR, agentOwnsPr: agentOwnsPR, prClaimVerified, noChangesToShip });
  // Merge per-task reviewer metadata with the user's Code Review Defaults
  // (Settings → Code Reviewers page). Settings I/O is cached inside the
  // resolver, so this is effectively free even when invoked from a tight CoS
  // sweep.
  const reviewOptions = prCreation !== PR_CREATION.NEVER
    ? await resolveReviewLoopOptions(task?.metadata, { normalize: normalizeReviewers })
      .catch(err => {
        emitLog('warn', `Review options unavailable for ${agentId}: ${err.message}`, { agentId, taskId: task?.id });
        return {};
      })
    : {};
  return {
    prCreation,
    prCompletion: resolvePrCompletion(task?.metadata),
    ...reviewOptions,
    // Review-loop follow-up agents already merged via `gh pr merge` in the agent
    // body — re-merging the worktree branch into the source workspace would
    // duplicate the squashed commits — and a harness that owns its PR workflow
    // lands its own PR; suppress the auto-merge fallback for both.
    skipMerge: isTruthyMeta(task?.metadata?.reviewLoopFollowUp) || agentOwnsPR,
    description: task?.description,
    agentOutput: outputBuffer,
    originalTask: task,
  };
}

/**
 * Run the post-finalize cleanup for a completed agent: JIRA push/PR/comment,
 * the plan-question notification marker, pipeline progression, the Creative
 * Director completion hook, and worktree cleanup (+ cleanup-warning
 * notification and merge-recovery task).
 *
 * Called from `handleAgentCompletion` after `finalizeAgent`, inside its
 * try/finally so `runnerAgents.delete(agentId)` still fires on a throw here.
 *
 * The retry hold is released in a `finally` (#3373): a failed task is left
 * `in_progress` + held by `finalizeAgent` so nothing can dequeue its retry before
 * the resume pointer is resolved, and ONLY this release makes it spawnable again.
 * So it cannot hang off the `if (!jiraBranch)` worktree branch below, and it cannot
 * be skipped by a throw from the JIRA/pipeline/Creative Director steps — either
 * would leave the task held until the orphan sweep noticed.
 *
 * @param {{ agentId: string, task: object, agent: object, effectiveSuccess: boolean, outputBuffer: string, noChangesToShip?: boolean }} params
 */
export async function runAgentCompletionCleanup({ agentId, task, agent, effectiveSuccess, outputBuffer, prClaimVerified = false, noChangesToShip = false }) {
  // Fetch agent state once for JIRA, plan-question, and the resume pointer. Its
  // worktree fields are stamped once at registerAgent and never mutated, so passing
  // it to the release spares a re-read that would re-split the whole output.txt.
  const { getAgent: getAgentState } = await import('./cos.js');
  const agentState = await getAgentState(agentId).catch(() => null);

  try {
    await runCompletionCleanupSteps({ agentId, task, agent, agentState, effectiveSuccess, outputBuffer, prClaimVerified, noChangesToShip });
  } finally {
    await releaseRetryHold({
      agentId,
      task,
      success: effectiveSuccess,
      agentMetadata: agentState?.metadata ?? null,
    }).catch(err => emitLog('warn', `Retry-hold release failed for ${agentId}: ${err.message}`, { agentId, taskId: task?.id }));
  }
}

/**
 * The cleanup steps themselves. Split from the public entry point above only so
 * the retry-hold release can wrap them in a `finally` without re-indenting them.
 */
async function runCompletionCleanupSteps({ agentId, task, agent, agentState, effectiveSuccess, outputBuffer, prClaimVerified = false, noChangesToShip = false }) {
  // JIRA integration: push branch, create PR, comment on ticket
  const jiraTicketId = task?.metadata?.jiraTicketId;
  const jiraBranch = task?.metadata?.jiraBranch;
  const jiraInstanceId = task?.metadata?.jiraInstanceId;
  const jiraCreatePR = task?.metadata?.jiraCreatePR;

  if (jiraTicketId && jiraBranch && effectiveSuccess) {
    const workspace = agentState?.metadata?.workspacePath || ROOT_DIR;

    let jiraTicketUrl = task?.metadata?.jiraTicketUrl || null;
    if (!jiraTicketUrl && jiraInstanceId) {
      const jiraConfig = await jiraService.getInstances().catch(() => null);
      const baseUrl = jiraConfig?.instances?.[jiraInstanceId]?.baseUrl;
      if (baseUrl) jiraTicketUrl = `${baseUrl}/browse/${jiraTicketId}`;
    }
    const jiraTicketRef = jiraTicketUrl ? `[${jiraTicketId}](${jiraTicketUrl})` : jiraTicketId;

    await git.push(workspace, jiraBranch).catch(err => {
      emitLog('warn', `Failed to push JIRA branch ${jiraBranch}: ${err.message}`, { agentId, ticketId: jiraTicketId });
    });

    let prUrl = null;
    if (jiraCreatePR !== false) {
      const { baseBranch, devBranch } = await git.getRepoBranches(workspace).catch(() => ({ baseBranch: null, devBranch: null }));
      const targetBranch = devBranch || baseBranch || 'main';

      const jiraPrBody = await git.generatePRDescription(workspace, targetBranch, jiraBranch, outputBuffer);
      const jiraPrBodyWithRef = `Resolves ${jiraTicketRef}\n\n${jiraPrBody}`;

      const baseTitle = await git.suggestPRTitle(workspace, targetBranch, jiraBranch, task.description);
      const jiraPrTitle = `${jiraTicketId}: ${baseTitle}`.substring(0, 100);

      const prResult = await git.createPR(workspace, {
        title: jiraPrTitle,
        body: jiraPrBodyWithRef,
        base: targetBranch,
        head: jiraBranch
      }).catch(err => {
        emitLog('warn', `Failed to create PR for ${jiraTicketId}: ${err.message}`, { agentId });
        return null;
      });

      if (prResult?.success) {
        prUrl = prResult.url;
        emitLog('success', `Created PR: ${prUrl}`, { agentId, ticketId: jiraTicketId });
      }
    }

    if (jiraInstanceId) {
      const commentLines = [`Agent completed task successfully.`];
      if (prUrl) {
        commentLines.push(`\n*Pull Request:* ${prUrl}`);
      } else if (jiraBranch) {
        commentLines.push(`\n*Branch:* \`${jiraBranch}\``);
      }
      await jiraService.addComment(jiraInstanceId, jiraTicketId, commentLines.join('\n')).catch(err => {
        emitLog('warn', `Failed to comment on JIRA ticket ${jiraTicketId}: ${err.message}`, { agentId });
      });
    }

    const { devBranch: dev, baseBranch: base } = await git.getRepoBranches(workspace).catch(() => ({ devBranch: null, baseBranch: null }));
    const returnBranch = dev || base || 'main';
    await git.checkout(workspace, returnBranch).catch(err => {
      emitLog('warn', `Failed to checkout back to ${returnBranch}: ${err.message}`, { agentId });
    });
  }

  // Check for plan questions marker file (feature-ideas / plan-task needing user input)
  const planAnalysisType = task?.metadata?.analysisType;
  if (planAnalysisType === 'feature-ideas' || planAnalysisType === 'plan-task') {
    const planWorkspace = agentState?.metadata?.workspacePath || task?.metadata?.repoPath || ROOT_DIR;
    const markerPath = join(planWorkspace, '.plan-questions.md');

    const markerContent = await tryReadFile(markerPath);
    if (markerContent) {
      const titleMatch = markerContent.match(/^#\s+Plan Question:\s*(.+)/m);
      const title = titleMatch?.[1]?.trim() || 'PLAN.md item needs your input';
      const appId = task.metadata?.app;

      const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
      await addNotification({
        type: NOTIFICATION_TYPES.PLAN_QUESTION,
        title,
        message: markerContent,
        priority: PRIORITY_LEVELS.MEDIUM,
        link: appId ? `/apps/${appId}/documents` : undefined,
        metadata: { appId, agentId, taskType: planAnalysisType }
      }).catch(err => {
        emitLog('warn', `Failed to create plan_question notification: ${err.message}`, { agentId });
      });

      await rm(markerPath).catch(() => {});
      emitLog('info', `📋 Plan question notification created: ${title}`, { agentId, appId });
    }
  }

  // Advance pipeline to next stage if applicable
  if (task?.metadata?.pipeline) {
    await handlePipelineProgression(task, agentId, effectiveSuccess);
  }

  // Advance Creative Director task chain if applicable. After a Creative
  // Director agent task (treatment or evaluate) finishes, the orchestrator
  // decides what comes next and enqueues it. Scene rendering and final
  // stitching run server-side rather than as separate CoS tasks, so they
  // never reach this hook directly. Failure marks the project failed; the
  // user can resume from the UI.
  if (task?.metadata?.creativeDirector) {
    const { handleCreativeDirectorCompletion } = await import('./creativeDirector/completionHook.js');
    handleCreativeDirectorCompletion(task, agentId, effectiveSuccess)
      .catch((err) => console.log(`⚠️ creativeDirector completion hook failed: ${err.message}`));
  }

  // Clean up worktree if agent was using one (skip merge when JIRA branch — PR handles merge)
  if (!jiraBranch) {
    const taskOpenPR = isTruthyMeta(task?.metadata?.openPR);
    // Who opens the PR, and whether finalize already checked that they did.
    // These two must match what the prompt actually told the agent or PortOS
    // double-fires `gh pr create` ("a pull request already exists" would then
    // preserve the worktree as a false-positive failure).
    //
    // Read off the PERSISTED record (#3358): the in-memory `runnerAgents` entry
    // carries only `providerId`, so a lean `--bare` or path-configured provider
    // would be misjudged from it. `resolveOwnsPrWorkflow` owns the stamped-vs-
    // derived fallback for pre-#3733 records, alongside the predicate itself.
    const providerDescriptor = {
      providerId: agentState?.metadata?.providerId ?? agent.providerId,
      providerCommand: agentState?.metadata?.providerCommand ?? agent.providerCommand ?? null,
      leanMode: (agentState?.metadata?.leanMode ?? agent.leanMode) === true,
    };
    const agentOwnsPR = taskOpenPR && resolveOwnsPrWorkflow({
      persisted: agentState?.metadata?.ownsPrWorkflow ?? agent.ownsPrWorkflow,
      ...providerDescriptor,
    });
    // `prClaimVerified` is the caller's — it carries whether finalize's check
    // ACTUALLY produced a forge answer for this run. Re-deriving it here from
    // `canTypeSlashCommands` would answer a different question ("was one
    // expected?") off a different expression than the one finalize used, and the
    // two silently disagree the moment a run's check throws or its finalize does.
    const cleanupWarnings = await cleanupAgentWorktree(agentId, effectiveSuccess, await resolveWorktreeCleanupOptions({
      agentId,
      task,
      outputBuffer,
      taskOpenPR,
      agentOwnsPR,
      prClaimVerified,
      noChangesToShip,
    }));

    if (cleanupWarnings?.length > 0) {
      const { getAgent: getAgentForResult } = await import('./cos.js');
      const currentAgent = await getAgentForResult(agentId).catch(() => null);
      await updateAgent(agentId, { result: { ...currentAgent?.result, warnings: cleanupWarnings } });

      const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
      const appName = task?.metadata?.appName || task?.metadata?.app || 'PortOS';
      await addNotification({
        type: NOTIFICATION_TYPES.AGENT_WARNING,
        title: `Agent cleanup issue: ${appName}`,
        description: cleanupWarnings.join('\n'),
        priority: PRIORITY_LEVELS.HIGH,
        link: '/cos/agents',
        metadata: { agentId, taskId: task?.id, warnings: cleanupWarnings }
      }).catch(err => {
        emitLog('warn', `Failed to create cleanup warning notification: ${err.message}`, { agentId });
      });

      void spawnMergeRecoveryTask(cleanupWarnings, agentId, task, appName, currentAgent?.metadata?.sourceWorkspace).catch(err => {
        emitLog('warn', `Failed to spawn merge recovery task: ${err.message}`, { agentId, taskId: task?.id });
      });
    }
  }
}

/**
 * The post-finalize dispatch for a run whose child process this server itself
 * owns — the TUI `finish()` handler (agentTuiSpawning.js) and the direct-CLI
 * `close` handler (agentCliSpawning.js) — and the counterpart of
 * `runAgentCompletionCleanup` above, which serves the runner-event path.
 *
 * Runs from the spawner's `finally`, after `finalizeAgent` has settled or
 * thrown. In order:
 *   1. advance a staged pipeline (`handlePipelineProgression`) BEFORE the
 *      worktree goes, since a stage precondition may read it;
 *   2. worktree cleanup with the PR disposition (`resolveWorktreeCleanupOptions`);
 *   3. release the retry hold — in a `finally`, as `runAgentCompletionCleanup`
 *      does, so no throw above can skip it. A failed task is left held by
 *      `finalizeAgent` so nothing can dequeue its retry before the resume
 *      pointer is written; the release flips it back to `pending` pointing at
 *      whatever cleanup preserved — the branch (or whole worktree) kept because
 *      the run failed with commits on it (#3368, #3373).
 * A failed step is logged and does not block the next one.
 *
 * Both spawners used to inline this sequence and mirror each other by hand, and
 * the mirror drifted in both directions: pipeline progression reached the CLI
 * copy (cd1d21211) but never the TUI one — so an attachable pipeline stage run
 * as a TUI (#6062) completed without advancing, or closing, its pipeline —
 * while the reviewer-resolve hardening reached the TUI copy (708c5e473) but not
 * the CLI one.
 *
 * `prOwnership` is `resolvePrOwnership`'s answer for this run;
 * `prClaimVerified` / `noChangesToShip` are read off finalize's return.
 * `success` is the verdict finalize actually persisted — a PR-claim downgrade
 * must reach cleanup, or a run that opened no PR is cleaned up as a success and
 * loses its retry state (#3358).
 */
export async function runSpawnerCompletionCleanup({ agentId, task, success, prOwnership, prClaimVerified = false, noChangesToShip = false, outputBuffer }) {
  try {
    await handlePipelineProgression(task, agentId, success)
      .catch(err => emitLog('warn', `Pipeline progression failed for ${agentId}: ${err.message}`, { agentId, taskId: task?.id }));
    const cleanupOptions = await resolveWorktreeCleanupOptions({
      agentId,
      task,
      outputBuffer,
      taskOpenPR: prOwnership.taskOpenPR,
      agentOwnsPR: prOwnership.agentOwnsPR,
      prClaimVerified,
      noChangesToShip,
    });
    await cleanupAgentWorktree(agentId, success, cleanupOptions)
      .catch(err => emitLog('warn', `Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId, taskId: task?.id }));
  } finally {
    await releaseRetryHold({ agentId, task, success })
      .catch(err => emitLog('warn', `Retry-hold release failed for ${agentId}: ${err.message}`, { agentId, taskId: task?.id }));
  }
}
