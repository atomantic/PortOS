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
 *     (agentCliSpawning.js). Runs the same post-finalize steps as the runner.
 *
 * Both hand `cleanupAgentWorktree` the options `resolveWorktreeCleanupOptions`
 * builds, so the PR-disposition shape has one owner. `handlePipelineProgression`
 * lives here too — it's only invoked from these cleanup flows (exported for its
 * unit tests).
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
import { resolvePrOpenedBy, PR_OPENED_BY } from '../lib/slashdoInvocation.js';
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
 * `taskOpenPR` / `agentOpensOwnPr` are the CALLER's: the spawners read them off
 * the live provider descriptor (`resolvePrOwnership`), the runner path off the
 * persisted agent record (`resolvePrOpenedBy`) — see #3358 for why the two
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
async function resolveWorktreeCleanupOptions({ agentId, task, outputBuffer, taskOpenPR, agentOpensOwnPr, prClaimVerified = false, noChangesToShip = false }) {
  // `if-missing` for an agent-owned PR that finalize did NOT verify: cleanup
  // asks the forge once and only stands down when a PR actually exists, so a
  // harness that skipped its completion workflow can't strand the branch.
  const prCreation = resolvePrCreation({ taskOpenPR, agentOpensOwnPr, prClaimVerified, noChangesToShip });
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
    // duplicate the squashed commits — and a harness that opens its own PR
    // lands it too; suppress the auto-merge fallback for both.
    skipMerge: isTruthyMeta(task?.metadata?.reviewLoopFollowUp) || agentOpensOwnPr,
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
    await runCompletionCleanupSteps({
      agentId, task, agent, agentState, effectiveSuccess, outputBuffer, prClaimVerified, noChangesToShip,
    });
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
 * One ordered post-finalize sequence for every completion path. Public entry
 * points own retry-hold release independently of these steps.
 */
async function runCompletionCleanupSteps(context) {
  // The spawners have always logged failed steps and continued; the runner
  // propagates them to its completion handler. Both execute the same sequence.
  const runStep = (name, step) => step().catch(err => {
    if (!context.continueOnError) throw err;
    emitLog('warn', `${name} failed for ${context.agentId}: ${err.message}`, { agentId: context.agentId, taskId: context.task?.id });
  });
  await runStep('JIRA hand-off', () => completeJiraHandOff(context));
  await runStep('Plan question notification', () => notifyPlanQuestionIfNeeded(context));
  await runStep('Pipeline progression', () => handlePipelineProgression(context.task, context.agentId, context.effectiveSuccess));
  await runStep('Creative Director completion', () => advanceCreativeDirectorIfNeeded(context));
  const cleanupWarnings = await runStep('Worktree cleanup', () => completeWorktreeCleanup(context));
  await runStep('Cleanup warning reporting', () => reportWorktreeCleanupWarnings({ ...context, cleanupWarnings }));
}

function resolveRunnerPrOwnership({ task, agent, agentState }) {
  const taskOpenPR = isTruthyMeta(task?.metadata?.openPR);
  // Who opens the PR, and whether finalize already checked that they did.
  // These two must match what the prompt actually told the agent or PortOS
  // double-fires `gh pr create` ("a pull request already exists" would then
  // preserve the worktree as a false-positive failure).
  //
  // Read off the PERSISTED record (#3358): the in-memory `runnerAgents` entry
  // carries only `providerId`, so a lean `--bare` or path-configured provider
  // would be misjudged from it. `resolvePrOpenedBy` owns the stamped-vs-
  // derived fallback, including the legacy `ownsPrWorkflow` boolean records
  // written before #6869 and the pre-#3733 records that carry nothing.
  const providerDescriptor = {
    providerId: agentState?.metadata?.providerId ?? agent.providerId,
    providerCommand: agentState?.metadata?.providerCommand ?? agent.providerCommand ?? null,
    leanMode: (agentState?.metadata?.leanMode ?? agent.leanMode) === true,
  };
  const prOpenedBy = resolvePrOpenedBy({
    persistedPrOpenedBy: agentState?.metadata?.prOpenedBy ?? agent.prOpenedBy,
    persistedOwnsPrWorkflow: agentState?.metadata?.ownsPrWorkflow ?? agent.ownsPrWorkflow,
    ...providerDescriptor,
  });
  const agentOpensOwnPr = taskOpenPR && prOpenedBy !== PR_OPENED_BY.PORTOS;
  return { taskOpenPR, agentOpensOwnPr };
}

async function completeJiraHandOff({ agentId, task, agentState, effectiveSuccess, outputBuffer }) {
  // JIRA integration: push branch, create PR, comment on ticket
  const jiraTicketId = task?.metadata?.jiraTicketId;
  const jiraBranch = task?.metadata?.jiraBranch;
  const jiraInstanceId = task?.metadata?.jiraInstanceId;
  const jiraCreatePR = task?.metadata?.jiraCreatePR;

  if (jiraTicketId && jiraBranch && effectiveSuccess) {
    const workspace = agentState?.metadata?.workspacePath || ROOT_DIR;

    const jiraTicketRef = await resolveJiraTicketRef(task.metadata);

    await git.push(workspace, jiraBranch).catch(err => {
      emitLog('warn', `Failed to push JIRA branch ${jiraBranch}: ${err.message}`, { agentId, ticketId: jiraTicketId });
    });

    const prUrl = jiraCreatePR === false ? null : await createJiraPullRequest({
      agentId, task, workspace, jiraTicketId, jiraTicketRef, jiraBranch, outputBuffer,
    });

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
}

async function resolveJiraTicketRef({ jiraTicketId, jiraTicketUrl, jiraInstanceId }) {
  let ticketUrl = jiraTicketUrl || null;
  if (!ticketUrl && jiraInstanceId) {
    const config = await jiraService.getInstances().catch(() => null);
    const baseUrl = config?.instances?.[jiraInstanceId]?.baseUrl;
    if (baseUrl) ticketUrl = `${baseUrl}/browse/${jiraTicketId}`;
  }
  return ticketUrl ? `[${jiraTicketId}](${ticketUrl})` : jiraTicketId;
}

async function createJiraPullRequest({ agentId, task, workspace, jiraTicketId, jiraTicketRef, jiraBranch, outputBuffer }) {
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
    const prUrl = prResult.url;
    emitLog('success', `Created PR: ${prUrl}`, { agentId, ticketId: jiraTicketId });
    return prUrl;
  }
  return null;
}

async function notifyPlanQuestionIfNeeded({ agentId, task, agentState }) {
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
}

async function advanceCreativeDirectorIfNeeded({ agentId, task, effectiveSuccess }) {
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
}

async function completeWorktreeCleanup({ agentId, task, agent, agentState, effectiveSuccess, prOwnership, outputBuffer, prClaimVerified, noChangesToShip }) {
  if (task?.metadata?.jiraBranch) return;
  const ownership = prOwnership ?? resolveRunnerPrOwnership({ task, agent, agentState });
  return cleanupAgentWorktree(agentId, effectiveSuccess, await resolveWorktreeCleanupOptions({
    agentId, task, outputBuffer,
    taskOpenPR: ownership.taskOpenPR,
    agentOpensOwnPr: ownership.agentOpensOwnPr,
    prClaimVerified, noChangesToShip,
  }));
}

async function reportWorktreeCleanupWarnings({ agentId, task, cleanupWarnings }) {
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

/**
 * The post-finalize dispatch for a run whose child process this server itself
 * owns — the TUI `finish()` handler (agentTuiSpawning.js) and the direct-CLI
 * `close` handler (agentCliSpawning.js) — and the counterpart of
 * `runAgentCompletionCleanup` above, which serves the runner-event path.
 *
 * Runs the shared step list from the spawner's `finally`, after finalize
 * settles or throws. Failed steps are logged without blocking later steps.
 * Retry-hold release remains in a `finally`: even a skipped JIRA worktree or
 * a failed hand-off must release the task with the resume pointer cleanup left.
 *
 * `prOwnership` is `resolvePrOwnership`'s answer for this run;
 * `prClaimVerified` / `noChangesToShip` are read off finalize's return.
 * `success` is the verdict finalize actually persisted — a PR-claim downgrade
 * must reach cleanup, or a run that opened no PR is cleaned up as a success and
 * loses its retry state (#3358).
 */
export async function runSpawnerCompletionCleanup({ agentId, task, success, prOwnership, prClaimVerified = false, noChangesToShip = false, outputBuffer }) {
  try {
    const { getAgent } = await import('./cos.js');
    const agentState = await getAgent(agentId).catch(() => null);
    await runCompletionCleanupSteps({
      agentId, task, agentState, effectiveSuccess: success, prOwnership,
      prClaimVerified, noChangesToShip, outputBuffer, continueOnError: true,
    });
  } finally {
    await releaseRetryHold({ agentId, task, success })
      .catch(err => emitLog('warn', `Retry-hold release failed for ${agentId}: ${err.message}`, { agentId, taskId: task?.id }));
  }
}
