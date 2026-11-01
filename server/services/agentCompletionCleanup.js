import { createHash } from 'node:crypto';
import { outsideGitMutationLifetime } from '../lib/gitMutationLifetime.js';
import { withDeliveryActivity } from './agentDeliveryActivity.js';
import { storeCompletionData, readCompletionData, completionReplayInput } from './agentCompletionData.js';
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

import { declaresNoCommitCriterion, resolveTaskHookType } from './taskTypeHooks.js';
import { join, relative, resolve, sep } from 'path';
import { unlink, rm } from 'fs/promises';
import { emitLog } from './cosEvents.js';
import { updateAgent } from './cosAgentLifecycle.js';
import { updateTask, addTask, reviveBlockedTask, getTaskById } from './cosTaskStore.js';
import { SPAWN_HISTORY_METADATA_KEYS } from './spawnBudgetProof.js';
import { CLAIM_METADATA_KEYS } from './cosTaskClaim.js';
import { checkStagePrecondition } from './cosTaskGenerator.js';
import { normalizeReviewers } from '../lib/validation.js';
import { applyStageExecution } from '../lib/pipelineStageExecution.js';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import { DONE_SENTINEL_NAME, doneSentinelName, doneSentinelPath as resolveDoneSentinelPath } from '../lib/agentSentinel.js';
import * as jiraService from './jira.js';
import * as git from './git.js';
import { isFalsyMeta, isTruthyMeta } from './agentState.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { cleanupAgentWorktree, spawnMergeRecoveryTask, releaseRetryHold } from './agentWorktreeCleanup.js';
import { PR_CREATION, resolvePrCompletion, resolvePrCreation } from '../lib/prDisposition.js';
import { resolvePrOpenedBy, PR_OPENED_BY } from '../lib/slashdoInvocation.js';
import { isPublicReviewRestrictedProfile, publicReviewPostureForProfile } from '../lib/agentExecutionProfiles.js';
import { acknowledgeCompletionSentinel, completionSentinelPresent } from './agentCompletionSentinel.js';

const ROOT_DIR = PATHS.root;

/**
 * Every independent step runs. The runner propagates its first failure only
 * after recording the other stages; in-process spawners log and return.
 */
export const STEP_ERROR_POLICY = Object.freeze({
  PROPAGATE: 'propagate',
  LOG_AND_CONTINUE: 'log-and-continue',
});

const cleanupRuns = new Map();

/**
 * Advance a pipeline to its next stage after the current stage completes.
 * Creates a new task for the next stage or marks the pipeline as complete/failed.
 */
export async function handlePipelineProgression(task, agentId, success) {
  const pipeline = task.metadata?.pipeline;
  if (!pipeline || pipeline.status !== 'running') return;

  const updatePipeline = async patch => {
    const written = await updateTask(task.id, patch, task.taskType);
    if (written?.error || written?.statusChanged) throw new Error(`pipeline-write-unverified: ${written.error || 'task changed'}`);
    return written;
  };

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
    await updatePipeline({
      metadata: { pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
    });
    emitLog('warn', `⛔ Pipeline ${pipeline.id} failed at stage ${currentStage}: ${stages[currentStage]?.name}`, { pipelineId: pipeline.id });
    return;
  }

  const nextStageIndex = currentStage + 1;
  if (nextStageIndex >= stages.length) {
    await updatePipeline({
      metadata: { pipeline: { ...pipeline, status: 'completed', stageResults: updatedResults } }
    });
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
    await updatePipeline({
      metadata: { pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
    });
    emitLog('warn', `⛔ Pipeline ${pipeline.id} stage ${nextStageIndex} declares no execution profile after a restricted stage`, { pipelineId: pipeline.id });
    return;
  }

  // Check next stage's precondition before advancing
  if (nextStage.precondition && task.metadata.repoPath) {
    const check = checkStagePrecondition(nextStage, task.metadata.repoPath);
    if (!check.passed) {
      await updatePipeline({
        metadata: { pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
      });
      emitLog('info', `⏭️ Pipeline ${pipeline.id} stage ${nextStageIndex} precondition failed: ${check.reason}`, { pipelineId: pipeline.id });
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
  // Provider/model/effort are SET-only (never cleared) on hand-off (applyStageExecution): a stage
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
    for (const key of ['provider', 'providerId', 'model', 'effort', 'executionOptions']) delete nextTask.metadata[key];
  }
  // The previous stage's agent payload must not travel: `description` above IS
  // this stage's prompt, and addTask only promotes it to `metadata.prompt` when
  // none is set — an inherited one made every stage after the first run on the
  // stage before it's instructions.
  delete nextTask.metadata.prompt;
  // Each stage is a new task with its own spawn budget. The prior stage's
  // dispatch accounting and claim lease would make addTask withhold the fresh
  // budget proof, so dispatch held every later stage, and the inherited live
  // lease refused the explicit budget reset too.
  for (const key of [...SPAWN_HISTORY_METADATA_KEYS, ...CLAIM_METADATA_KEYS, 'lastOrphanedAt', 'worktreeBusyAttempts']) delete nextTask.metadata[key];
  // The profile, unlike the pins applied below, is SET-OR-CLEARED (see the guard at the
  // top of the hand-off): each stage runs under exactly the contract it
  // declares, never the previous stage's.
  nextTask.metadata.executionProfile = nextStage.executionProfile || null;
  applyStageExecution(nextTask.metadata, nextStage, {
    taskDefaults: pipeline.taskDefaults,
    clearInheritedExecutionOptions: true,
  });

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
    emitLog('info', `⏭️ Pipeline ${pipeline.id} stage ${nextStageIndex} already queued as ${persisted.id} (${persisted.status}) — skipping duplicate advance`, { pipelineId: pipeline.id, agentId });
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
async function resolveWorktreeCleanupOptions({ agentId, task, outputBuffer, taskOpenPR, agentOpensOwnPr, prClaimVerified = false, branchProvenEmpty = false }) {
  // Old tracker dispatches inherited openPR even though their deliverable was
  // filed issues. Preserve their checkout through the ordinary cleanup gates;
  // never validate, publish or merge source on that inherited instruction.
  const noWorktreeOutput = isFalsyMeta(task?.metadata?.worktreeChangesExpected) && declaresNoCommitCriterion(task);
  // `if-missing` for an agent-owned PR that finalize did NOT verify: cleanup
  // asks the forge once and only stands down when a PR actually exists, so a
  // harness that skipped its completion workflow can't strand the branch.
  const prCreation = noWorktreeOutput ? PR_CREATION.NEVER
    : resolvePrCreation({ taskOpenPR, agentOpensOwnPr, prClaimVerified, branchProvenEmpty });
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
    skipMerge: noWorktreeOutput || isTruthyMeta(task?.metadata?.reviewLoopFollowUp) || agentOpensOwnPr,
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
 * @param {{ agentId: string, task: object, agent: object, effectiveSuccess: boolean, outputBuffer: string, branchProvenEmpty?: boolean }} params
 */
export async function runAgentCompletionCleanup(input) {
  return outsideGitMutationLifetime(() => runAgentCompletionCleanupInOwnContext(input));
}

async function runAgentCompletionCleanupInOwnContext({ agentId, task, agent, effectiveSuccess, outputBuffer, prClaimVerified = false, branchProvenEmpty = false }) {
  // Fetch agent state once for JIRA, plan-question, and the resume pointer. Its
  // worktree fields are stamped once at registerAgent and never mutated, so passing
  // it to the release spares a re-read that would re-split the whole output.txt.
  const { getAgent: getAgentState } = await import('./cosAgentLifecycle.js');
  const agentState = await getAgentState(agentId).catch(() => null);

  try {
    // Inside the `try`: a throw here must still reach the retry-hold release.
    const prOwnership = resolveRunnerPrOwnership({ task, agent, agentState });
    await runCompletionCleanupSteps({
      agentId, task, agent, agentState, effectiveSuccess, prOwnership, outputBuffer, prClaimVerified, branchProvenEmpty,
    }, { onStepError: STEP_ERROR_POLICY.PROPAGATE });
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
 * points own retry-hold release independently of these steps, and choose
 * `onStepError` (a `STEP_ERROR_POLICY` value) for how a failed step is treated.
 *
 * `context.prOwnership` is `{ taskOpenPR, agentOpensOwnPr }`, resolved by the
 * entry point from its own source of truth.
 */
async function runCompletionCleanupSteps(...args) {
  return outsideGitMutationLifetime(() => runCompletionCleanupInOwnContext(...args));
}

async function runCompletionCleanupInOwnContext(context, { onStepError }) {
  if (!Object.values(STEP_ERROR_POLICY).includes(onStepError)) throw new Error(`Unknown completion-cleanup step error policy: ${onStepError}`);
  if (cleanupRuns.has(context.agentId)) return cleanupRuns.get(context.agentId);
  const run = withDeliveryActivity(context.agentId, 'Processing completion handoffs and workspace cleanup',
    async () => {
      if (context.agentState?.status === 'completed') {
        // A delayed duplicate can arrive after the first replay left the
        // single-flight map. Re-read its durable stages inside this turn.
        const lifecycle = await import('./cosAgentLifecycle.js');
        const current = await lifecycle.getAgentRecord(context.agentId);
        if (!current || current.startedAt !== context.agentState.startedAt) return;
        context = { ...context, agentState: current };
      }
      return performCompletionCleanupSteps(context, onStepError);
    });
  cleanupRuns.set(context.agentId, run);
  try { return await run; } finally { cleanupRuns.delete(context.agentId); }
}

/** Complete the task whose audit block this run still owns. The output hook
 * already ran at finalization; a refused guard is the operator's later edit
 * and is not retried. A store failure stays pending for the next replay.
 */
async function settleVerifiedAuditTask(agentState) {
  const task = await getTaskById(agentState?.taskId);
  const { verifiedAuditTaskFence } = await import('./agentCompletionTaskHandoff.js');
  const fence = verifiedAuditTaskFence(agentState, task);
  if (!fence) return;
  const saved = await updateTask(fence.taskId, {
    status: 'completed',
    metadata: { taskOutcome: { status: 'completed', reason: 'Audit findings were verified by completion replay.' } },
  }, fence.taskType, { expectedStatus: fence.expectedStatus, expectedMetadata: fence.expectedMetadata });
  if (saved?.statusChanged || saved?.error === 'Task not found') return;
  if (saved?.error || saved?.status !== 'completed') throw new Error('verified-audit-task-settlement-unverified');
}

async function performCompletionCleanupSteps(context, onStepError) {
  const state = context.agentState;
  const durable = state?.status === 'completed' && typeof state.startedAt === 'string';
  if (durable && ['completed', 'failed', 'abandoned'].includes(state.metadata?.completionCleanup?.status)) return;
  const stages = { ...state?.metadata?.completionCleanup?.stages };
  const { recordCompletionCleanup } = durable ? await import('./cosAgentLifecycle.js') : {};
  const persist = async patch => {
    if (durable && !await recordCompletionCleanup(context.agentId, state.startedAt, patch)) throw new Error('completion-cleanup-write-unverified');
  };
  // A crash after terminal ingestion but before any step leaves this exact
  // continuation on disk. Replays do not rerun completed external side effects.
  const priorReplay = state?.metadata?.completionCleanup?.replay;
  const replayInput = durable && priorReplay ? await readCompletionData(state, priorReplay)
    : state?.metadata?.completionCleanup?.context || completionReplayInput(context);
  const replay = durable ? priorReplay || await storeCompletionData(state, 'replay', replayInput) : undefined;
  context = { ...context, ...replayInput };
  await persist({ version: 1, status: 'pending', startedAt: state?.startedAt, replay, context: undefined });
  // A received register held only by unverified rows re-verifies on replay, so
  // a since-merged fix or a recovered forge does not preserve evidence forever.
  if (priorReplay && state.metadata?.auditFindings?.finalReportReceived === true && auditEvidencePending(context)) {
    const { settleAuditFindings } = await import('./auditFindings.js');
    const settled = await settleAuditFindings({ task: context.task, agentId: context.agentId,
      workspacePath: state.metadata.workspacePath }).catch(() => null);
    if (settled?.status === 'complete') {
      context = { ...context, agentState: { ...state, metadata: { ...state.metadata,
        auditFindings: { ...state.metadata.auditFindings, status: 'complete' } } } };
    }
  }
  // Findings may already be complete from an earlier replay whose task write
  // did not land. The original pass has no replay yet, so finalization's own
  // verdict is left alone.
  const findings = context.agentState?.metadata?.auditFindings;
  const verifiedAudit = priorReplay && findings?.finalReportReceived === true && findings.status === 'complete'
    && Number(context.task?.metadata?.auditDispositionVersion ?? context.agentState?.metadata?.auditDispositionVersion) === 1;
  let firstError;
  const runStep = async (key, name, step, retryable = false) => {
    const prior = stages[key];
    if (prior?.status === 'done') return prior.value;
    if (prior && !retryable) {
      if (prior.status === 'running') {
        stages[key] = { ...prior, status: 'abandoned', reason: 'external-handoff-unverified' };
        await persist({ stages: { [key]: stages[key] } });
      }
      return; // Unknown external effects are terminal here, never republished.
    }
    try {
      stages[key] = { status: 'running', retryable };
      await persist({ stages: { [key]: stages[key] } });
      const value = await step();
      const held = (key === 'worktree' && Array.isArray(value) && value.length > 0)
        || (key === 'sentinel' && auditEvidencePending(context));
      stages[key] = { status: held ? 'held' : 'done', retryable: false, ...(value !== undefined && { value }) };
      await persist({ stages: { [key]: stages[key] } });
      return value;
    } catch (err) {
      const deferred = ['checkout-capture-pending', 'checkout-retirement-pending',
        'completion-sentinel-generation-pending', 'completion-sentinel-generation-changed'].includes(err.message);
      if (!deferred) firstError ||= err;
      stages[key] = { status: deferred ? 'held' : 'failed', retryable: deferred || retryable, reason: err.message };
      await persist({ stages: { [key]: stages[key] } }).catch(() => {});
      emitLog(deferred ? 'info' : 'warn', `${name} ${deferred ? 'deferred' : 'failed'} for ${context.agentId}: ${err.message}`,
        { agentId: context.agentId, taskId: context.task?.id });
    }
  };
  if (verifiedAudit) {
    await runStep('auditTask', 'Verified audit task settlement', () => settleVerifiedAuditTask(context.agentState), true);
  }
  // Durable ingestion and its continuation are sufficient to acknowledge this
  // exact signal. An unrelated hand-off failure must not leave it as Git dirt.
  if (['completed', 'failed'].includes(state?.status)) {
    await runStep('sentinel', 'Completion sentinel removal', () => removeCompletionSentinel(context), true);
  }
  const deliveryContext = context;
  await runStep('jira', 'JIRA hand-off', () => {
    if (context.task?.metadata?.jiraTicketId && state?.metadata?.checkoutCapture?.status === 'pending') throw new Error('checkout-capture-pending');
    return completeJiraHandOff(deliveryContext);
  }, stages.jira?.reason === 'checkout-capture-pending');
  await runStep('notification', 'Plan question notification', () => notifyPlanQuestionIfNeeded(context));
  const waitForRepository = () => {
    if (state?.metadata?.checkoutCapture?.status === 'pending') throw new Error('checkout-capture-pending');
    const worktree = state?.metadata?.completionCleanup?.stages?.worktree;
    // A cleanup-only recheck verified the repository but left task settlement
    // to the verification pass that follows this replay.
    const deferredSettlement = worktree?.status === 'done' && worktree.verifiedBy === 'repository-state-verification'
      && worktree.taskSettlement === 'after-completion-stages';
    if (state?.result?.cleanupPending === true && !deferredSettlement
      && (state.metadata?.repoStateVerification?.status !== 'completed'
        || !['repository-preservation-receipt', 'repository-state-verification'].includes(state.metadata?.completionCleanup?.stages?.worktree?.verifiedBy))) throw new Error('checkout-retirement-pending');
  };
  await runStep('pipeline', 'Pipeline progression', () => {
    if (context.task?.metadata?.pipeline?.status === 'running') waitForRepository();
    return handlePipelineProgression(context.task, context.agentId, deliveryContext.effectiveSuccess);
  }, ['checkout-capture-pending', 'checkout-retirement-pending'].includes(stages.pipeline?.reason));
  await runStep('creative', 'Creative Director completion', () => {
    if (context.task?.metadata?.creativeDirector) waitForRepository();
    return advanceCreativeDirectorIfNeeded(deliveryContext);
  }, ['checkout-capture-pending', 'checkout-retirement-pending'].includes(stages.creative?.reason));
  // A terminal rejection is not proof that its audit artifacts were consumed.
  // Keep the checkout and original signal available for explicit recovery.
  const preserveAuditEvidence = auditEvidencePending(context);
  if (preserveAuditEvidence) {
    emitLog('warn', `Audit disposition incomplete for ${context.agentId}; preserving worktree and completion evidence`, { agentId: context.agentId });
  }
  const cleanupWarnings = preserveAuditEvidence ? [] : await runStep('worktree', 'Worktree cleanup', async () => {
    if (state?.metadata?.checkoutCapture?.status === 'pending') throw new Error('checkout-capture-pending');
    if (await completionSentinelPresent(context.agentId, state?.metadata?.workspacePath)) throw new Error('completion-sentinel-generation-pending');
    return completeWorktreeCleanup(context);
  },
    // Workspace retirement revalidates identity, ownership, delivery and bytes on
    // every attempt. A pre-release hold is not an unknown external side effect.
    !stages.worktree || stages.worktree.retryable === true || stages.worktree.status === 'held');
  if (['done', 'held'].includes(stages.worktree?.status)) {
    await runStep('report', 'Cleanup warning reporting', () => reportWorktreeCleanupWarnings({ ...context, cleanupWarnings }));
  }
  const unfinished = preserveAuditEvidence || Object.values(stages).some(stage => stage.status === 'held'
    || (stage.status === 'failed' && stage.retryable) || stage.status === 'running');
  const failed = Object.values(stages).some(stage => ['failed', 'abandoned'].includes(stage.status));
  await persist({ status: unfinished ? 'pending' : failed ? 'failed' : 'completed' });
  if (firstError && onStepError === STEP_ERROR_POLICY.PROPAGATE) throw firstError;
}

/** Late completion callbacks replay only durable unfinished cleanup, never the
 * provider result, output hook, task verdict or a completed external hand-off.
 */
export async function replayAgentCompletionCleanup(agentState) {
  const receipt = agentState?.metadata?.completionCleanup;
  if (agentState?.status !== 'completed' || receipt?.version !== 1 || receipt.status !== 'pending') return;
  const { recordCompletionCleanup } = await import('./cosAgentLifecycle.js');
  let saved;
  try { saved = receipt.replay ? await readCompletionData(agentState, receipt.replay) : receipt.context; }
  catch {
    await recordCompletionCleanup(agentState.id, agentState.startedAt, { reason: 'completion-replay-unavailable' });
    return;
  }
  if (!saved || receipt.startedAt !== agentState.startedAt || saved.task?.id !== agentState.taskId) {
    await recordCompletionCleanup(agentState.id, agentState.startedAt, { status: 'abandoned', reason: 'completion-context-unavailable' });
    return;
  }
  if (agentState.metadata.checkoutCapture?.status === 'pending') {
    const lifecycle = await import('./cosAgentLifecycle.js');
    if (await lifecycle.retryCompletionCheckoutCapture(agentState.id).catch(() => false)) {
      agentState = await lifecycle.getAgentRecord(agentState.id);
    }
  }
  return runCompletionCleanupSteps({ ...saved,
    prOwnership: saved.prOwnership || resolveRunnerPrOwnership({ task: saved.task, agent: {}, agentState }),
    agentId: agentState.id, agentState }, { onStepError: STEP_ERROR_POLICY.LOG_AND_CONTINUE });
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
  if (resolveTaskHookType(task) === 'app-checkout-recovery') return;
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
      agentId, task, workspace, jiraTicketId, jiraTicketRef, jiraBranch, outputBuffer, scannerMetadata: agentState?.metadata,
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

async function createJiraPullRequest({ agentId, task, workspace, jiraTicketId, jiraTicketRef, jiraBranch, outputBuffer, scannerMetadata }) {
  const { baseBranch, devBranch } = await git.getRepoBranches(workspace).catch(() => ({ baseBranch: null, devBranch: null }));
  const targetBranch = devBranch || baseBranch || 'main';

  const jiraPrBody = await git.generatePRDescription(workspace, targetBranch, jiraBranch, outputBuffer, scannerMetadata?.securityScan, scannerMetadata?.securityScanControl);
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
        metadata: { appId, agentId, taskType: planAnalysisType, category: 'plan-question' }
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
    await handleCreativeDirectorCompletion(task, agentId, effectiveSuccess);
  }
}

function auditEvidencePending({ task, agentState }) {
  return Number(task?.metadata?.auditDispositionVersion ?? agentState?.metadata?.auditDispositionVersion) === 1
    && agentState?.metadata?.auditFindings?.status !== 'complete';
}

/**
 * Delete the run's own `.agent-done-<agentId>` completion sentinel.
 *
 * The sentinel is a runtime signal, not a work product: once a run has an
 * outcome nothing reads it again, and a worktree-LESS run (the issue-filing,
 * reasoning and read-only audit task types) executes in a real checkout — this
 * repo, or a managed app's own — where it would otherwise sit in the user's
 * `git status` as untracked dirt, one file per run, forever.
 *
 * Pause and host-shutdown abandon both return before any completion cleanup
 * runs (`finalizeAgentRunCommon`), and a run is abandoned only when it wrote no
 * sentinel at all (`shouldAbandonForHostShutdown`) — so this never eats a
 * signal a resume still needs.
 *
 * The workspace comes from the agent record — the cwd stamped at registration,
 * which is the directory the run wrote its sentinel into (a worktree run
 * records its worktree here).
 */
export async function removeCompletionSentinel({ agentId, agent, agentState, task }) {
  if (auditEvidencePending({ task, agentState })) return;
  // An id that yields no usable slug makes `doneSentinelName` fall back to the
  // bare, unscoped `.agent-done` — which belongs to no run and may be a legacy
  // agent's live signal (the sweep protects it with an age floor for exactly
  // that reason). Ask the producer rather than re-deriving its rule: the
  // fallback fires on a blank id AND on one whose sanitized slug is empty.
  if (typeof agentId !== 'string' || doneSentinelName(agentId) === DONE_SENTINEL_NAME) return;
  const workspace = agentState?.metadata?.workspacePath || agent?.workspacePath || null;
  if (!workspace) return;
  const receipt = agentState?.metadata?.completionSentinel;
  // No sentinel is harmless. An occupied marker without ingestion evidence is
  // not acknowledged, even for a completed record predating this protocol.
  if (!receipt && !await tryReadFile(resolveDoneSentinelPath(workspace, agentId))) return;
  const payload = agentState?.metadata?.completionSentinelData;
  if (payload) {
    const contents = await readCompletionData(agentState, payload);
    if (typeof contents !== 'string' || createHash('sha256').update(contents).digest('hex') !== receipt?.sha256) {
      throw new Error('completion-ingestion-data-unverified');
    }
  }
  await acknowledgeCompletionSentinel({ agentId, workspace, receipt });
}

async function completeWorktreeCleanup({ agentId, task, effectiveSuccess, prOwnership, outputBuffer, prClaimVerified, branchProvenEmpty }) {
  // This task owns the actual checkout and its preservation branches.
  // No CoS coordinator worktree exists to publish, merge, or remove.
  if (resolveTaskHookType(task) === 'app-checkout-recovery') return;
  if (task?.metadata?.jiraBranch) return;
  return cleanupAgentWorktree(agentId, effectiveSuccess, await resolveWorktreeCleanupOptions({
    agentId, task, outputBuffer,
    taskOpenPR: prOwnership.taskOpenPR,
    agentOpensOwnPr: prOwnership.agentOpensOwnPr,
    prClaimVerified, branchProvenEmpty,
  }));
}

async function reportWorktreeCleanupWarnings({ agentId, task, cleanupWarnings }) {
  if (cleanupWarnings?.length > 0) {
    const { getAgent: getAgentForResult } = await import('./cosAgentLifecycle.js');
    const currentAgent = await getAgentForResult(agentId).catch(() => null);
    await updateAgent(agentId, { result: { ...currentAgent?.result, warnings: cleanupWarnings } });
    // The original task already owns a bounded retry, cleanup proof, or human
    // decision. Another recovery task would race it or bypass its safety stop.
    if (currentAgent?.result?.deliveryRecoveryOwned === true) return;

    const appName = task?.metadata?.appName || task?.metadata?.app || 'PortOS';
    await spawnMergeRecoveryTask(cleanupWarnings, agentId, task, appName, currentAgent?.metadata?.sourceWorkspace);
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
 * `prClaimVerified` / `branchProvenEmpty` are read off finalize's return.
 * `success` is the verdict finalize actually persisted — a PR-claim downgrade
 * must reach cleanup, or a run that opened no PR is cleaned up as a success and
 * loses its retry state (#3358).
 */
export async function runSpawnerCompletionCleanup(input) {
  return outsideGitMutationLifetime(() => runSpawnerCompletionCleanupInOwnContext(input));
}

async function runSpawnerCompletionCleanupInOwnContext({ agentId, task, success: effectiveSuccess, prOwnership, prClaimVerified = false, branchProvenEmpty = false, outputBuffer }) {
  let agentState = null;
  try {
    const { getAgent } = await import('./cosAgentLifecycle.js');
    agentState = await getAgent(agentId).catch(() => null);
    await runCompletionCleanupSteps({
      agentId, task, agentState, effectiveSuccess, prOwnership,
      prClaimVerified, branchProvenEmpty, outputBuffer,
    }, { onStepError: STEP_ERROR_POLICY.LOG_AND_CONTINUE });
  } finally {
    await releaseRetryHold({ agentId, task, success: effectiveSuccess, agentMetadata: agentState?.metadata ?? null })
      .catch(err => emitLog('warn', `Retry-hold release failed for ${agentId}: ${err.message}`, { agentId, taskId: task?.id }));
  }
}
