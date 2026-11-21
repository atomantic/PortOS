/** Confidence approval, stage preconditions and worktree delivery policy shared by CoS improvement task generators. */

import { existsSync } from 'fs';
import { join } from 'path';
import { PIPELINE_STAGE_BEHAVIOR_FLAGS } from '../../lib/cos/cosTaskMetadata.js';
import { emitLog } from './cosEvents.js';
import { getTaskTypeConfidence } from '../taskLearning.js';
import { classifySafetyKind, requiresSafetyApproval } from '../taskLearning/safetyKind.js';
import { resolveAppPrCompletion } from '../../lib/prDisposition.js';
import { applyStageExecution } from '../../lib/pipelineStageExecution.js';
import { isTruthyMeta, isFalsyMeta } from '../../lib/metadataFlags.js';

/**
 * Resolve auto-approval for a task based on confidence scoring, with a
 * safety-kind override (#2440) that is orthogonal to confidence.
 *
 * Outward-facing / irreversible work (publishing content, federating records to
 * sync peers, external/upstream PRs, releases) always requires the user's
 * sign-off no matter how high the task type's success rate is — a high score
 * can't undo work that has already left the install. Reversible internal work
 * (analysis, refactor, same-repo improvement PRs) keeps the pure success-rate
 * gate, so existing behavior is unchanged unless the task carries an outward
 * signal.
 *
 * Returns { autoApproved, approvalRequired, safetyKind, approvalReason? } ready
 * to spread into task objects — `safetyKind` + `approvalReason` surface WHY a
 * high-confidence task still needs approval on the task record and in the UI.
 */
export function isConfiguredApprovalRequired(metadata) {
  return metadata?.requireApproval === true;
}

export async function resolveConfidenceApproval(state, taskTypeKey, logLabel, metadata = {}) {
  const safety = classifySafetyKind({ taskTypeKey, metadata });
  const safetyConfig = state?.config?.safetyKindApproval ?? {};

  // Explicit per-type/per-app toggle wins over every automatic gate. The user
  // turned "Require approval" on for this scheduled type; do not second-guess
  // that with confidence or a Run Now consent flip.
  if (isConfiguredApprovalRequired(metadata)) {
    emitLog('info', `🔒 ${logLabel} requires approval (task metadata requireApproval)`, {}, '[Approval]');
    return {
      autoApproved: false,
      approvalRequired: true,
      safetyKind: safety.kind,
      approvalReason: 'config:requireApproval'
    };
  }

  // Safety-kind override runs BEFORE (and independent of) the confidence gate.
  if (safety.outwardFacing && requiresSafetyApproval(safety.kind, safetyConfig)) {
    emitLog('info', `🔒 ${logLabel} requires approval (safety-kind: ${safety.kind} — ${safety.reason})`, {}, '[Safety]');
    return {
      autoApproved: false,
      approvalRequired: true,
      safetyKind: safety.kind,
      approvalReason: `safety-kind:${safety.kind}`
    };
  }

  const config = state?.config?.confidenceAutoApproval ?? {};
  if (config.enabled === false) {
    return { autoApproved: true, approvalRequired: false, safetyKind: safety.kind };
  }

  const confidence = await getTaskTypeConfidence(taskTypeKey, config);
  if (!confidence.autoApprove) {
    emitLog('info', `🔒 ${logLabel} requires approval (${confidence.reason})`, {}, '[Confidence]');
  }
  return {
    autoApproved: confidence.autoApprove,
    approvalRequired: !confidence.autoApprove,
    safetyKind: safety.kind,
    ...(confidence.autoApprove ? {} : { approvalReason: `confidence:${confidence.tier}` })
  };
}

/**
 * Clicking Run (or a refill of that run) is the user's consent. Safety-kind
 * and confidence gates exist so UNATTENDED queue-path work can't ship
 * irreversible actions on its own — they must not re-hold a task the user
 * just asked to run, or "Run Now" lands in awaiting-approve and never
 * auto-spawns (Priority 2 only picks AUTO tasks; force-spawn refuses
 * APPROVAL tasks).
 *
 * `metadata.requireApproval` is the escape hatch: a type the user marked
 * "always ask" (e.g. do-release when they want to review the merge)
 * keeps the hold even on Run Now.
 */
export function applyOnDemandConsent(task) {
  if (!task) return task;
  if (isConfiguredApprovalRequired(task.metadata)) return task;
  task.approvalRequired = false;
  task.autoApproved = true;
  if ('approvalReason' in task) delete task.approvalReason;
  // The hint TaskItem reads lives on metadata — COS-TASKS.md only persists
  // that bag. Clear both so a consented Run Now does not keep a stale reason.
  if (task.metadata && 'approvalReason' in task.metadata) delete task.metadata.approvalReason;
  return task;
}

export function stampApprovalReason(metadata, approval) {
  if (approval?.approvalReason) metadata.approvalReason = approval.approvalReason;
  else delete metadata.approvalReason;
}

/**
 * Check if a pipeline stage's precondition is met.
 * Supports { fileExists: 'path' } and { fileNotExists: 'path' }.
 * Paths are relative to repoPath.
 */
export function checkStagePrecondition(stage, repoPath) {
  const pre = stage?.precondition;
  if (!pre || !repoPath) return { passed: true };
  if (pre.fileExists) {
    const fullPath = join(repoPath, pre.fileExists);
    if (!existsSync(fullPath)) return { passed: false, reason: `${pre.fileExists} does not exist` };
  }
  if (pre.fileNotExists) {
    const fullPath = join(repoPath, pre.fileNotExists);
    if (existsSync(fullPath)) return { passed: false, reason: `${pre.fileNotExists} already exists` };
  }
  return { passed: true };
}

/**
 * Check stage 0 precondition after pipeline initialization.
 * Returns true if the task should be skipped (precondition failed).
 */
export function shouldSkipForPrecondition(metadata, app, analysisType) {
  const stage0 = metadata.pipeline?.stages?.[0];
  if (!stage0?.precondition) return false;
  const check = checkStagePrecondition(stage0, app.repoPath);
  if (!check.passed) {
    emitLog('info', `⏭️ Skipping ${analysisType} for ${app.name}: ${check.reason}`, { appId: app.id, analysisType });
    return true;
  }
  return false;
}

/**
 * Initialize pipeline runtime state on metadata if pipeline stages are configured.
 * Mutates the metadata object in place.
 */
export function initializePipelineMetadata(metadata) {
  if (!metadata.pipeline?.stages?.length) return;
  metadata.pipeline = {
    ...metadata.pipeline,
    id: `pipeline-${Date.now().toString(36)}`,
    currentStage: 0,
    stageResults: [],
    previousStageAgentId: null,
    status: 'running'
  };
  const stage0 = metadata.pipeline.stages[0];
  if (stage0.readOnly !== undefined) {
    metadata.readOnly = stage0.readOnly;
  }
  // Snapshot the task-level flags before stage 0's overrides land on them.
  const taskDefaults = {};
  for (const flag of PIPELINE_STAGE_BEHAVIOR_FLAGS) {
    if (metadata[flag] !== undefined) taskDefaults[flag] = metadata[flag];
  }
  metadata.pipeline.taskDefaults = taskDefaults;
  applyStageExecution(metadata, stage0, { taskDefaults });
}

// Apply app-level worktree/PR defaults only when not already set by task-type metadata.
// openPR is applied first since it implies useWorktree — this prevents defaultUseWorktree: false
// from blocking defaultOpenPR: true when both are app-level defaults.
export function applyAppWorktreeDefault(metadata, app) {
  const taskTypeDisabledWorktree = isFalsyMeta(metadata.useWorktree);

  // Apply defaultOpenPR first (since openPR implies useWorktree)
  if (metadata.openPR === undefined) {
    if (app.defaultOpenPR === true && !taskTypeDisabledWorktree) {
      metadata.openPR = true;
      metadata.useWorktree = true; // openPR implies useWorktree
    } else if (app.defaultOpenPR === false || taskTypeDisabledWorktree) {
      metadata.openPR = false;
    } else if ((app.defaultUseWorktree === true || isTruthyMeta(metadata.useWorktree)) && app.defaultOpenPR !== false) {
      metadata.openPR = true;
      metadata.useWorktree = true;
    }
  }

  // Apply defaultUseWorktree (only if not already set by task-type or openPR above)
  if (metadata.useWorktree === undefined) {
    // openPR implies useWorktree — don't let app default override explicit openPR: true
    const explicitOpenPR = isTruthyMeta(metadata.openPR);
    if (explicitOpenPR) {
      metadata.useWorktree = true;
    } else if (app.defaultUseWorktree === true) {
      metadata.useWorktree = true;
    } else if (app.defaultUseWorktree === false) {
      metadata.useWorktree = false;
    }
  }

  // Final invariant: openPR implies useWorktree (normalize in both directions)
  const finalOpenPR = isTruthyMeta(metadata.openPR);
  const finalWorktreeOff = isFalsyMeta(metadata.useWorktree);
  if (finalOpenPR && finalWorktreeOff) {
    // openPR wins — force useWorktree on
    metadata.useWorktree = true;
  } else if (finalWorktreeOff) {
    metadata.openPR = false;
  }

  // Pin the policy on new PR tasks so later app-default changes cannot change
  // a running task's authority. Stored legacy tasks are resolved separately.
  if ((finalOpenPR || isTruthyMeta(metadata.claimFlow)) && metadata.prCompletion === undefined) {
    metadata.prCompletion = resolveAppPrCompletion(app, metadata);
  }
}
