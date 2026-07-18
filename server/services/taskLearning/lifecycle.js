/**
 * Task Learning — lifecycle & backfill
 *
 * Wires the learning system into the CoS event stream (recording every
 * agent completion, self-healing tier metrics on boot) and provides the
 * one-shot backfill that seeds learning data from the existing agent
 * archive.
 */

import { cosEvents, emitLog } from './store.js';
import { recordTaskCompletion, recalculateModelTierMetrics } from './metrics.js';
import { isNonCommittingCoordinatorTask } from '../taskTypeHooks.js';

// A pre-#2696 gh/git coordinator run (branch-reconcile/issue-reconcile/branch-cleanup/
// jira-status-report) carries a FOSSIL `result.validationPassed` — a boolean the old
// `[task-<id>]` commit criterion stamped on a run that never makes such a commit (almost
// always `false`). recordTaskCompletion trusts a persisted boolean over the exit code, so
// re-recording one verbatim would restore the very bucket migration 198 purged. These types
// now declare NO commit criterion, so drop the fossil and let the exit-code success stand —
// exactly as finalize now records a live coordinator run. Non-coordinator agents (and those
// with no boolean verdict) pass through untouched.
function withoutStaleCoordinatorVerdict(agent, task) {
  if (!isNonCommittingCoordinatorTask(task)) return agent;
  if (typeof agent?.result?.validationPassed !== 'boolean') return agent;
  return { ...agent, result: { ...agent.result, validationPassed: null } };
}

/**
 * Initialize learning system - listen for agent completions
 */
export function initTaskLearning() {
  cosEvents.on('agent:completed', async (agent) => {
    // Get task info from agent
    const task = {
      id: agent.taskId,
      description: agent.metadata?.taskDescription,
      taskType: agent.metadata?.taskType,
      metadata: agent.metadata
    };

    await recordTaskCompletion(agent, task).catch(err => {
      console.error(`❌ 📚 TaskLearning: Failed to record completion: ${err.message}`);
    });
  });

  // Self-heal model tier metrics on startup
  recalculateModelTierMetrics().catch(err => {
    console.error(`❌ 📚 TaskLearning: Failed to recalculate model tiers: ${err.message}`);
  });

  emitLog('info', 'Task Learning System initialized', {}, '📚 TaskLearning');
}

/**
 * Backfill learning data from existing completed agents
 * Call this once to populate historical data
 */
export async function backfillFromHistory() {
  const { getAgents } = await import('../cos.js');
  const agents = await getAgents();

  let backfilled = 0;
  for (const agent of agents) {
    if (agent.status === 'completed' && agent.result) {
      const task = {
        id: agent.taskId,
        description: agent.metadata?.taskDescription,
        taskType: agent.metadata?.taskType,
        metadata: agent.metadata
      };

      await recordTaskCompletion(withoutStaleCoordinatorVerdict(agent, task), task).catch(() => {});
      backfilled++;
    }
  }

  emitLog('info', `Backfilled ${backfilled} completed tasks into learning system`, { backfilled }, '📚 TaskLearning');
  return backfilled;
}
