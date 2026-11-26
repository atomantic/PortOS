/**
 * Reconciles in-progress task records against live and recently completed agents.
 */

import { isInternalTaskId } from '../../lib/taskParser.js';
import { isRetryHeld, isStaleRetryHold, isDeliveryCleanupHeld } from '../../lib/taskRetryHold.js';
import { loadState } from './cosState.js';
import { emitLog } from './cosEvents.js';
import { getAllTasks, getTaskById, updateTask } from './cosTaskStore.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { isHeldByOther, buildRenewal, buildClaim, getClaimOwner } from './cosTaskClaim.js';
import { closeStalePreflightCard, isPreflightCard, isStalePreflightCard } from '../preflightTaskCard.js';
import { requireCosOrphanRecoveryHandlers } from '../bootHookRegistry.js';

// A task whose agent reported completed within this window is treated as
// "recently completed" and protected from resetOrphanedTasks's reaper.
const RECENT_COMPLETION_GRACE_MS = 60_000;

/**
 * Reset orphaned in_progress tasks back to pending
 * (tasks marked in_progress but no running agent)
 *
 * `bootRecovery` says this is the startup pass, where no in-process worktree
 * cleanup can possibly be running — so a retry hold (#3373) is recovered
 * immediately instead of waiting out its liveness grace, which on the periodic
 * pass is what stops the sweep stealing a task mid-cleanup.
 */
export async function resetOrphanedTasks({ bootRecovery = false } = {}) {
  const state = await loadState();
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  // This machine's federation identity, for the cross-instance lease checks
  // below (issue #1563). `ensureInstanceId()` resolves the real id on the cold
  // path so a boot-time orphan-reset never compares against the `unknown`
  // sentinel.
  const instanceId = await ensureInstanceId();

  const runningAgentTaskIds = Object.values(state.agents)
    .filter(a => a.status === 'running')
    .map(a => a.taskId);

  // The most recent agent per task. Handing it to handleOrphanedTask lets the retry
  // resume the worktree/branch that run left behind instead of restarting — the
  // residue this pass catches (an agent that died partway through its own cleanup,
  // or was archived while its task stayed in_progress) leaves exactly the same
  // preserved worktree the boot sweep's orphans do. Absent (already archived) just
  // means no pointer and a clean start, which is the pre-existing behavior.
  const lastAgentByTask = new Map();
  for (const agent of Object.values(state.agents)) {
    if (!agent.taskId) continue;
    const previous = lastAgentByTask.get(agent.taskId);
    if (!previous || new Date(agent.startedAt || 0) >= new Date(previous.startedAt || 0)) {
      lastAgentByTask.set(agent.taskId, agent);
    }
  }

  // Also track tasks with recently-completed agents to avoid race condition:
  // Between completeAgent() and updateTask(), the agent is "completed" but the
  // task is still "in_progress". Without this check, resetOrphanedTasks treats
  // such tasks as orphaned and increments orphanRetryCount spuriously.
  const recentlyCompletedTaskIds = new Set(
    Object.values(state.agents)
      .filter(a => a.status === 'completed' && a.completedAt &&
        (Date.now() - new Date(a.completedAt).getTime()) < RECENT_COMPLETION_GRACE_MS)
      .map(a => a.taskId)
  );

  emitLog('debug', `Running agents: ${runningAgentTaskIds.length}, recently completed: ${recentlyCompletedTaskIds.size}`, { taskIds: runningAgentTaskIds });

  // Route orphaned tasks through handleOrphanedTask for consistent retry counting,
  // cooldown enforcement, and max-spawn limits (prevents runaway respawning)
  const { handleOrphanedTask } = requireCosOrphanRecoveryHandlers();

  // A programmatic-phase card (services/preflightTaskCard.js) is `in_progress`
  // with no agent BY DESIGN — it describes deterministic pre-agent work, has no
  // prompt, and must never be handed to `handleOrphanedTask`, which would flip
  // it to `pending` and spawn an agent on a task that is only a progress
  // display. A card stranded by a restart is closed as interrupted instead, and
  // one still inside its grace window is left alone: a pr-reviewer security
  // scan is minutes of real work, and reaping a live preflight would make the
  // card lie in the one direction that matters.

  const processOrphanedTasks = async (tasks) => {
    for (const task of tasks) {
      if (isPreflightCard(task)) {
        if (isStalePreflightCard(task)) {
          const closed = await closeStalePreflightCard(task).catch(error => {
            emitLog('warn', `Unable to verify stale preflight ownership: ${error.message}`, { taskId: task.id });
            return false;
          });
          if (closed) emitLog('info', `Closing preflight card ${task.id} — no process is still running its checks`, { taskId: task.id });
        }
        continue;
      }
      if (runningAgentTaskIds.includes(task.id)) {
        // A local agent is actively working this task — renew its federation
        // lease (the heartbeat, issue #1563) so a peer sharing this task list
        // keeps seeing it as live-claimed across a long run instead of treating
        // it as orphaned once the original lease window elapses. We can only
        // hold a lease we own (or freshly claim an unclaimed legacy task); never
        // steal a lease another instance owns.
        const owner = getClaimOwner(task.metadata);
        const renewal = owner === instanceId
          ? buildRenewal(task.metadata, instanceId)
          : (owner === null ? buildClaim(instanceId) : null);
        if (renewal) {
          const taskType = task.taskType || (isInternalTaskId(task.id) ? 'internal' : 'user');
          // Pass ONLY the renewal claim keys — updateTask merges them over the
          // CURRENT persisted metadata, so spreading {...task.metadata} (this
          // scan's possibly-stale copy) is redundant and would risk clobbering a
          // concurrent content edit. It also keeps the heartbeat a claim-only
          // patch so it never bumps the updatedAt LWW stamp (#1714).
          await updateTask(task.id, { metadata: renewal }, taskType).catch(err => {
            emitLog('warn', `⚠️ Lease renewal failed for task ${task.id}: ${err?.message || err}`, { taskId: task.id, stack: err?.stack || '' });
          });
        }
        continue;
      }
      // A failed task held non-spawnable while its worktree cleanup resolves the
      // resume pointer (#3373). While the hold is fresh some in-process cleanup is
      // still expected to release it, so leave it alone — requeueing here would
      // resolve the pointer against a branch mid-merge. Once the hold is stale, or
      // this is the boot pass (nothing can be mid-cleanup in a process that just
      // started), the process that armed it is gone and `handleOrphanedTask`
      // finishes the transition instead of treating the task as a fresh orphan.
      //
      // Evaluated BEFORE the recently-completed grace below, which it deliberately
      // bypasses: the hold is armed AFTER `completeAgent`, so a crash-restart
      // inside that 60s window would otherwise skip the very task the boot pass
      // exists to recover and strand it until the 15-minute periodic sweep.
      if (isDeliveryCleanupHeld(task.metadata)) continue;
      const held = isRetryHeld(task.metadata);
      const recoverHold = held && (bootRecovery || isStaleRetryHold(task.metadata));
      if (held && !recoverHold) {
        emitLog('debug', `Skipping task ${task.id} — retry held while its worktree cleanup finishes`, { taskId: task.id });
        continue;
      }
      // Skip tasks whose agent just completed — updateTask will set them to
      // completed shortly; treating them as orphaned causes spurious retries
      if (!recoverHold && recentlyCompletedTaskIds.has(task.id)) {
        emitLog('debug', `Skipping task ${task.id} — agent recently completed, awaiting task status update`, { taskId: task.id });
        continue;
      }
      // Only the latest run can settle a missed task update. An older success
      // must not hide a failed rerun that needs orphan recovery.
      const lastAgent = lastAgentByTask.get(task.id);
      const successAgentId = lastAgent?.status === 'completed' && lastAgent.result?.success ? lastAgent.id : null;
      if (successAgentId) {
        emitLog('warn', `🔧 Task ${task.id} still in_progress but agent ${successAgentId} completed successfully — completing task now (missed update)`, { taskId: task.id, agentId: successAgentId });
        await updateTask(task.id, { status: 'completed' }, task.taskType || (isInternalTaskId(task.id) ? 'internal' : 'user'));
        continue;
      }
      // Cross-instance lease guard (issue #1563, acceptance criterion 3): a
      // federated peer holds a live claim on this task, so it is being worked on
      // the other machine — not orphaned here. Resetting it to pending would
      // race a second agent onto work the peer is already doing. Leave it; the
      // lease expires on its own if the peer actually died.
      if (isHeldByOther(task.metadata, instanceId)) {
        emitLog('debug', `Skipping task ${task.id} — live lease held by instance ${getClaimOwner(task.metadata)}`, { taskId: task.id });
        continue;
      }
      emitLog('info', `Found orphaned in_progress task ${task.id}, routing through retry handler`, { taskId: task.id });
      const deadAgent = lastAgentByTask.get(task.id);
      await handleOrphanedTask(task.id, deadAgent?.id || 'unknown-reset', getTaskById, { agentMetadata: deadAgent?.metadata, agentStartedAt: deadAgent?.startedAt });
    }
  };

  await processOrphanedTasks(userTaskData.grouped.in_progress || []);
  await processOrphanedTasks(cosTaskData.grouped.in_progress || []);
}
