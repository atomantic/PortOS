/**
 * Investigation retry — put a failure-blocked task back in the queue as soon as
 * the investigation that diagnosed it finishes.
 *
 * The failure loop used to be open at both ends. #3714 closed the first half:
 * an agent failure files an investigation task that runs UNATTENDED, so nobody
 * has to approve the diagnosis. But the original task stayed `blocked` forever
 * after the fix landed — the only ways out were a human unblocking it by hand or
 * the 14-day reaper quietly auto-expiring it as stale. So the fix shipped and
 * the work it unblocked never ran.
 *
 * This module closes the second half: when an investigation task completes, the
 * tasks it named in `metadata.affectedTasks` are revived automatically. Bounded
 * by `MAX_AUTO_RETRIES_PER_TASK` so an unresolvable cause can't spin
 * investigate → retry → fail → investigate forever — past the budget the task
 * stays blocked, saying so, and the next same-cause investigation trips the
 * `repeat-fingerprint` hold, which IS the point where a human is the right
 * answer.
 *
 * Imports `cosTaskStore` directly rather than the `cos.js` facade: `cos.js`
 * subscribes to this module's entry point, so going back through the facade
 * would close a load-time cycle.
 */

import { getAllTasks, reviveBlockedTask, updateTask } from './cosTaskStore.js';
import { emitLog } from './cosEvents.js';
import { matchesSpawnBudgetProof, spawnBudgetCount, validSpawnBudgetEpisode } from './spawnBudgetProof.js';
import {
  MAX_AUTO_RETRIES_PER_TASK,
  RETRY_SKIP_REASONS,
  affectedTaskIds,
  autoRetryMetadata,
  couldReleaseBlockedTasks,
  resolveInvestigationRetryTargets,
} from '../lib/investigationTasks.js';

// What a task's `blockedReason` becomes once the auto-retry loop gives up on it,
// so the queue says "the loop stopped trying" rather than still showing whatever
// failure blocked it two retries ago. Every other retry budget in CoS stamps its
// exhaustion onto the task; this one would otherwise report only to the journal,
// which is the one place the user won't look.
const RETRY_EXHAUSTED_CATEGORY = 'auto-retry-exhausted';

/**
 * Revive every still-blocked task the just-completed `investigation` was
 * tracking. A no-op (returning zero retried) for anything that is not a
 * genuinely-finished investigation, so the caller can hand it every completed
 * task without pre-filtering.
 *
 * Never throws: it runs off an event listener, outside the request lifecycle.
 *
 * @param {object} investigation the task that just reached `completed`
 * @returns {Promise<{ retried: string[], skipped: Array<{ taskId: string, reason: string }> }>}
 */
export async function retryTasksResolvedByInvestigation(investigation, { now = Date.now() } = {}) {
  // Answered from the task in hand, before any I/O — every task completion on the
  // install reaches this, and the reaper alone flips up to 50 investigations to
  // `completed` per sweep that release nothing (see couldReleaseBlockedTasks).
  if (!couldReleaseBlockedTasks(investigation)) return { retried: [], skipped: [] };

  // Index ONLY the ids this investigation names — usually one — rather than
  // cloning both whole queues to look them up. `getAllTasks` returns each queue's
  // raw tasks without a `taskType`, but the revive has to write back to the file
  // the task actually lives in, so stamp it from the queue it came out of.
  const wanted = new Set(affectedTaskIds(investigation));
  const { user, cos } = await getAllTasks();
  const tasksById = new Map();
  for (const [taskType, list] of [['user', user?.tasks || []], ['internal', cos?.tasks || []]]) {
    for (const task of list) if (wanted.has(task.id)) tasksById.set(task.id, { ...task, taskType });
  }

  const { targets, skipped } = resolveInvestigationRetryTargets({ investigation, tasksById });

  const retried = [];
  for (const task of targets) {
    if (task.metadata?.spawnBudgetReconciledHold === 'true') {
      skipped.push({ taskId: task.id, reason: 'spawn-budget-reconciled-held' });
      continue;
    }
    const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
    const state = await readAgentsStateForSafetyCheck().catch(() => null);
    const owner = state?.trusted ? state.agents?.[task.metadata?.spawnBudgetProof?.dispatch?.agentId] : null;
    const count = spawnBudgetCount(task.metadata?.totalSpawnCount);
    const charged = spawnBudgetCount(task.metadata?.spawnBudgetProof?.dispatch?.totalSpawnCount);
    const undispatched = state?.trusted && validSpawnBudgetEpisode(task.metadata?.spawnBudgetProof)
      && task.metadata.spawnBudgetProof.dispatch === null
      && spawnBudgetCount(task.metadata.totalSpawnCount ?? 0) === spawnBudgetCount(task.metadata.spawnBudgetProof.baseline ?? 0);
    if (owner?.status === 'completed' && matchesSpawnBudgetProof(task, owner) && count !== null && charged !== null && count < charged) {
      const { reconcileSpawnBudget } = await import('./spawnBudgetReconciliation.js');
      const result = await reconcileSpawnBudget(task.id).catch(() => null);
      skipped.push({ taskId: task.id, reason: result?.reconciled ? 'spawn-budget-reconciled-held' : 'spawn-budget-reconciliation-required' });
      continue;
    }
    if (!undispatched && (!owner || owner.status !== 'completed' || !owner.startedAt || !matchesSpawnBudgetProof(task, owner)
      || count === null || count !== charged)) {
      skipped.push({ taskId: task.id, reason: 'spawn-budget-reconciliation-required' });
      continue;
    }
    // `reviveBlockedTask` clears the block + failure/spawn budgets and emits
    // `tasks:changed` action `unblocked`, which wakes the dequeue — so the retry
    // starts on its own without a second signal from here.
    const result = await reviveBlockedTask(
      task.id,
      { metadata: autoRetryMetadata(task, investigation.id, now) },
      task.taskType,
      { expectedStatus: 'blocked', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
        recoveryOwner: { id: owner?.id || 'undispatched-investigation-retry', startedAt: owner?.startedAt || null, requireInactive: true } }
    ).catch((err) => ({ error: err.message }));

    if (result?.error || result?.statusChanged) {
      emitLog('warn', `⚠️ Auto-retry of task ${task.id} after investigation ${investigation.id} failed: ${result.error || 'task or owner changed'}`, {
        taskId: task.id, investigationTaskId: investigation.id
      });
      continue;
    }
    retried.push(task.id);
  }

  await markExhaustedTasks(skipped, tasksById, investigation.id, now);

  if (retried.length > 0) {
    emitLog('info', `🔁 Investigation ${investigation.id} resolved — auto-retrying ${retried.length} blocked task(s): ${retried.join(', ')}`, {
      taskId: investigation.id, retried: retried.length, skipped: skipped.length
    });
  } else if (skipped.length > 0) {
    emitLog('debug', `⏭️ Investigation ${investigation.id} revived nothing: ${skipped.map(s => `${s.taskId} (${s.reason})`).join(', ')}`, {
      taskId: investigation.id, skipped: skipped.length
    });
  }
  return { retried, skipped };
}

/**
 * Re-label the tasks whose auto-retry budget just ran out, so the task list says
 * the loop gave up instead of still showing the original failure. Idempotent —
 * a task already carrying the category is left alone, so a second investigation
 * naming it doesn't rewrite the same reason. Best-effort: a failed re-label must
 * not lose the retries that did land.
 */
async function markExhaustedTasks(skipped, tasksById, investigationId, now) {
  for (const { taskId, reason } of skipped) {
    if (reason !== RETRY_SKIP_REASONS.BUDGET_EXHAUSTED) continue;
    const task = tasksById.get(taskId);
    if (task?.metadata?.blockedCategory === RETRY_EXHAUSTED_CATEGORY) continue;
    await updateTask(taskId, {
      metadata: {
        blockedReason: `Auto-retry gave up after ${MAX_AUTO_RETRIES_PER_TASK} attempts — the same cause keeps blocking this task`,
        blockedCategory: RETRY_EXHAUSTED_CATEGORY,
        autoRetryExhaustedAt: new Date(now).toISOString(),
      }
    }, task?.taskType || 'internal', { expectedStatus: 'blocked',
      expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
      recoveryOwner: { id: 'unattributed-investigation-retry', startedAt: null, requireInactive: true } }).catch((err) => {
      emitLog('warn', `⚠️ Could not mark task ${taskId} auto-retry-exhausted after investigation ${investigationId}: ${err.message}`, { taskId });
    });
  }
}
