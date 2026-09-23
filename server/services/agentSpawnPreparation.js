import { cosEvents, emitLog } from './cosEvents.js';
import { getTaskById, updateTask } from './cos.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { isRetryHeld } from '../lib/taskRetryHold.js';
import { createToolExecution, startExecution, completeExecution, errorExecution } from './toolStateMachine.js';
import { determineLane, acquire, release } from './executionLanes.js';
import { PATHS } from '../lib/fileUtils.js';
import { getAppWorkspace } from './agentPromptBuilder.js';
import { publicReviewPostureForProfile, PUBLIC_REVIEW_NO_TOOL_POSTURE } from '../lib/providerVendors.js';
import { ensureInstanceId } from './instanceIdentity.js';
import { isClaimableBy, buildClaim, buildRelease, getClaimOwner, getTargetInstance, isTargetedElsewhere } from './cosTaskClaim.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { v4 as uuidv4 } from '../lib/uuid.js';

const ROOT_DIR = PATHS.root;

export function createAgentSpawnContext(task) {
  const context = {
    task,
    instanceId: null,
    agentId: null,
    laneName: null,
    toolExecution: null,
    laneAcquired: false,
    claimAcquired: false,
    spawnWorktree: null,
    handedOff: false,
    setupCatchArmed: false,
  };

  context.cleanupOnError = async (error) => {
    if (context.laneAcquired) release(context.agentId);
    if (context.toolExecution) {
      errorExecution(context.toolExecution.id, { message: error });
      completeExecution(context.toolExecution.id, { success: false });
    }
    if (context.claimAcquired) {
      await updateTask(context.task.id, { metadata: buildRelease() }, context.task.taskType || 'user').catch(() => {});
    }
    await releaseAppReviewMarker(context.task.metadata?.app).catch(err => {
      emitLog('warn', `Failed to release app review marker for ${context.task.metadata?.app}: ${err.message}`, { taskId: context.task.id });
    });
    if (context.spawnWorktree) {
      const { removeWorktree } = await import('./worktreeManager.js');
      const sourceWorkspace = context.task.metadata?.app
        ? await getAppWorkspace(context.task.metadata.app).catch(() => ROOT_DIR)
        : ROOT_DIR;
      await removeWorktree(context.agentId, sourceWorkspace, context.spawnWorktree.branchName, { discardDirt: true }).catch((cleanupErr) => {
        emitLog('warn', `Failed to remove the worktree of failed spawn ${context.agentId}: ${cleanupErr.message}`, { agentId: context.agentId, taskId: context.task.id });
      });
    }
  };

  context.blockAndBail = async ({ reason, category, infrastructureCode, emit = 'agent:error', emitPayload = {}, persist = true }) => {
    if (persist) {
      await updateTask(context.task.id, {
        status: 'blocked',
        metadata: {
          ...context.task.metadata,
          blockedReason: reason,
          blockedCategory: category,
          blockedAt: new Date().toISOString(),
        },
      }, context.task.taskType || 'user').catch(() => {});
    }
    await context.cleanupOnError(reason);
    if (emit === 'agent:error'
      && publicReviewPostureForProfile(context.task.metadata?.executionProfile) === PUBLIC_REVIEW_NO_TOOL_POSTURE
      && (infrastructureCode || category?.startsWith('public-review-model-') || category === 'public-review-provider-unsupported')) {
      const { reportReviewInfrastructureFailure } = await import('./reviewInfrastructureFailure.js');
      await reportReviewInfrastructureFailure({ code: infrastructureCode || category, task: context.task }).catch(() => {
        emitLog('warn', 'Could not report PR review infrastructure failure', { taskId: context.task.id });
      });
      emit = 'warn-log';
    }
    if (emit === 'agent:error') {
      cosEvents.emit('agent:error', { taskId: context.task.id, error: reason, ...emitPayload });
    } else if (emit === 'warn-log') {
      emitLog('warn', `Public review withheld for task ${context.task.id}: ${category}`, { taskId: context.task.id });
    }
    return null;
  };

  return context;
}

export async function prepareAgentSpawn(task, context = createAgentSpawnContext(task)) {
  if (task && !task.taskType) {
    task.taskType = isInternalTaskId(task.id || '') ? 'internal' : 'user';
  }

  let instanceId;
  try {
    instanceId = await ensureInstanceId();
  } catch (err) {
    emitLog('error', `Failed to resolve instance identity for task ${task.id}: ${err?.message || err}`, { taskId: task.id });
    return null;
  }
  context.instanceId = instanceId;
  if (isTargetedElsewhere(task.metadata, instanceId)) {
    console.log(`📍 Task ${task.id} is assigned to instance ${getTargetInstance(task.metadata)} — skipping spawn on ${instanceId}`);
    return null;
  }
  if (!isClaimableBy(task.metadata, instanceId)) {
    console.log(`🔒 Task ${task.id} is claimed by instance ${getClaimOwner(task.metadata)} (live lease) — skipping spawn on ${instanceId}`);
    return null;
  }

  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  if (totalSpawns >= MAX_TOTAL_SPAWNS) {
    console.log(`🚫 Task ${task.id} hit max total spawns (${totalSpawns}/${MAX_TOTAL_SPAWNS}), blocking`);
    return context.blockAndBail({
      reason: `Max total spawns exceeded (${totalSpawns}/${MAX_TOTAL_SPAWNS})`,
      category: 'max-spawns',
      emit: 'none',
    });
  }

  context.agentId = `agent-${uuidv4().slice(0, 8)}`;
  context.laneName = determineLane(task);
  const laneResult = acquire(context.laneName, context.agentId, { taskId: task.id });
  if (!laneResult.success) {
    emitLog('warn', `Failed to tag lane ${context.laneName}: ${laneResult.error}`, { taskId: task.id });
    await context.cleanupOnError(`Failed to tag lane ${context.laneName}`);
    return null;
  }
  context.laneAcquired = true;

  context.toolExecution = createToolExecution('agent-spawn', context.agentId, {
    taskId: task.id,
    lane: context.laneName,
    priority: task.priority,
  });
  startExecution(context.toolExecution.id);

  const freshTask = await getTaskById(task.id).catch(() => null);
  if (freshTask) {
    if (isRetryHeld(freshTask.metadata)) {
      console.log(`⏳ Task ${task.id} is held for its retry pointer — not spawning until cleanup releases it`);
      await context.cleanupOnError('retry held pending cleanup');
      return null;
    }
    if (isTargetedElsewhere(freshTask.metadata, instanceId)) {
      console.log(`📍 Task ${task.id} is assigned to instance ${getTargetInstance(freshTask.metadata)} — yielding on ${instanceId}`);
      await context.cleanupOnError('assigned to another instance');
      return null;
    }
    if (!isClaimableBy(freshTask.metadata, instanceId)) {
      console.log(`🔒 Task ${task.id} was claimed by instance ${getClaimOwner(freshTask.metadata)} during dispatch — yielding on ${instanceId}`);
      await context.cleanupOnError('claimed by another instance');
      return null;
    }
    const claimUpdate = await updateTask(task.id, {
      metadata: buildClaim(instanceId),
    }, task.taskType || 'user').catch(() => null);
    if (claimUpdate && !claimUpdate.error) {
      context.claimAcquired = true;
      task.metadata = claimUpdate.metadata;
    }
  }

  context.setupCatchArmed = true;
  return context;
}
