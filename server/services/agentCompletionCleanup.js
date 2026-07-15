/**
 * Agent Completion Cleanup
 *
 * The post-finalize orchestration that runs after `finalizeAgent` inside
 * `handleAgentCompletion`: JIRA branch push + PR + ticket comment, the
 * plan-question notification marker, pipeline-stage progression, the Creative
 * Director chain hook, and worktree cleanup (with cleanup-warning
 * notifications + merge-recovery task). Extracted from agentLifecycle.js to
 * keep `handleAgentCompletion`'s try/finally guard small and obvious.
 *
 * `handlePipelineProgression` lives here too — it's only invoked from this
 * cleanup flow (agentLifecycle.js re-exports it for subAgentSpawner).
 *
 * This module imports the worktree-cleanup leaf (agentWorktreeCleanup.js)
 * directly; it must NOT import from agentLifecycle.js, which imports this
 * module — that would form a cycle.
 */

import { join, relative, resolve, sep } from 'path';
import { unlink, rm } from 'fs/promises';
import { emitLog } from './cosEvents.js';
import { updateAgent } from './cosAgents.js';
import { updateTask, addTask, checkStagePrecondition } from './cos.js';
import { PIPELINE_BEHAVIOR_FLAGS, normalizeReviewers } from '../lib/validation.js';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import * as jiraService from './jira.js';
import * as git from './git.js';
import { isTruthyMeta } from './agentState.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { cleanupAgentWorktree, spawnMergeRecoveryTask } from './agentWorktreeCleanup.js';

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
  if (nextStage.model) nextTask.metadata.model = nextStage.model;
  if (nextStage.providerId) {
    nextTask.metadata.provider = nextStage.providerId;
    nextTask.metadata.providerId = nextStage.providerId;
  }
  if (nextStage.effort) nextTask.metadata.effort = nextStage.effort;
  // Apply per-stage overrides for agent behavior flags
  const stageReadOnly = nextStage.readOnly ?? false;
  const taskDefaults = pipeline.taskDefaults || {};
  for (const flag of PIPELINE_BEHAVIOR_FLAGS) {
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
    // not minting a duplicate. updateTask clears the blocked metadata on the
    // status transition and merges in the new pipeline state.
    if (persisted.status === 'blocked') {
      await updateTask(persisted.id, {
        status: 'pending',
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
 * Run the post-finalize cleanup for a completed agent: JIRA push/PR/comment,
 * the plan-question notification marker, pipeline progression, the Creative
 * Director completion hook, and worktree cleanup (+ cleanup-warning
 * notification and merge-recovery task).
 *
 * Called from `handleAgentCompletion` after `finalizeAgent`, inside its
 * try/finally so `runnerAgents.delete(agentId)` still fires on a throw here.
 *
 * @param {{ agentId: string, task: object, agent: object, effectiveSuccess: boolean, outputBuffer: string }} params
 */
export async function runAgentCompletionCleanup({ agentId, task, agent, effectiveSuccess, outputBuffer }) {
  // Fetch agent state once for JIRA and plan-question blocks
  const { getAgent: getAgentState } = await import('./cos.js');
  const agentState = await getAgentState(agentId).catch(() => null);

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
    const taskReviewLoop = isTruthyMeta(task?.metadata?.reviewLoop);
    // Review-loop follow-up agents already merged via `gh pr merge` in the agent
    // body — re-merging the worktree branch into the source workspace would
    // duplicate the squashed commits, so suppress the auto-merge fallback.
    const taskReviewLoopFollowUp = isTruthyMeta(task?.metadata?.reviewLoopFollowUp);
    // Claude Code CLI agents run `/simplify` + `/do:pr` themselves (see
    // buildCliCompletionSection in agentPromptBuilder.js) — they push the
    // branch and open the PR on their own. Mirror the TUI cleanup contract
    // so PortOS doesn't double-fire `gh pr create` ("a pull request already
    // exists" would preserve the worktree as a false-positive failure).
    const agentOwnsPR = taskOpenPR && (agent.providerId === 'claude-code' || agent.providerId === 'claude-code-bedrock');
    // Merge per-task reviewer metadata with the user's Code Review Defaults
    // (AI Providers → Code Review Defaults panel). Settings I/O is cached
    // inside the resolver, so this is effectively free even when invoked
    // from a tight CoS sweep.
    const reviewOptions = await resolveReviewLoopOptions(task?.metadata, { normalize: normalizeReviewers, isTruthyMeta });
    const cleanupWarnings = await cleanupAgentWorktree(agentId, effectiveSuccess, {
      openPR: agentOwnsPR ? false : taskOpenPR,
      requestCopilotReview: !agentOwnsPR && taskOpenPR && taskReviewLoop,
      ...reviewOptions,
      skipMerge: taskReviewLoopFollowUp || agentOwnsPR,
      description: task?.description,
      agentOutput: outputBuffer,
      originalTask: task
    });

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
