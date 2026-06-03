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

      await recordTaskCompletion(agent, task).catch(() => {});
      backfilled++;
    }
  }

  emitLog('info', `Backfilled ${backfilled} completed tasks into learning system`, { backfilled }, '📚 TaskLearning');
  return backfilled;
}
