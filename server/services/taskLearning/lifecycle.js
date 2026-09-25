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
import { declaresNoCommitCriterion, isClaimFlowDispatch } from '../taskTypeHooks.js';
import { isAgentHandoff } from '../../lib/agentOutcome.js';

// A pre-#2696 gh/git coordinator run (branch-reconcile/issue-reconcile/branch-cleanup/
// jira-status-report) carries a FOSSIL `result.validationPassed` — a boolean the old
// commit criterion stamped on a run that never makes such a commit (almost
// always `false`). recordTaskCompletion trusts a persisted boolean over the exit code, so
// re-recording one verbatim would restore the very bucket migration 198 purged. These types
// now declare NO commit criterion, so drop the fossil and let the exit-code success stand —
// exactly as finalize now records a live coordinator run. Non-coordinator agents (and those
// with no boolean verdict) pass through untouched.
//
// Keyed on the same `declaresNoCommitCriterion` predicate the live criterion uses, so the
// backfill also drops the fossil off a tracker-filing run (`worktreeChangesExpected: false`,
// e.g. a reference-watch run on a github-tracker app) — the identical artifact, just carried
// on a per-task flag instead of the static type set (#3273).
//
// CLAIM flows (plan-task / claim-issue / claim-issue-gitlab / claim-issue-jira /
// claim-work) carry the same fossil for the same reason: their commits land in the
// claim/<item> worktree the agent cuts, so the parent-workspace probe stamped
// `validationPassed: false` on successful runs. Keyed on `isClaimFlowDispatch`
// (not declaresNoCommitCriterion, which claim flows deliberately do NOT satisfy)
// so a backfill re-recording an archived claim run drops the fossil instead of
// restoring the poisoned bucket the claim-flow purge migration removed.
function withoutStaleCoordinatorVerdict(agent, task) {
  if (!declaresNoCommitCriterion(task) && !isClaimFlowDispatch(task)) return agent;
  if (typeof agent?.result?.validationPassed !== 'boolean') return agent;
  return { ...agent, result: { ...agent.result, validationPassed: null } };
}

/**
 * Initialize learning system - listen for agent completions
 */
export function initTaskLearning() {
  cosEvents.on('agent:completed', async (agent) => {
    // A record retired by `resumeAgent` is a CONTINUATION, not an outcome: the run
    // was paused by the user and its task is already back in the queue, where the
    // resumed run will record the real verdict. Learning from it would charge the
    // task type and model tier a phantom failure per pause, and double-count the
    // task once the continuation finishes.
    if (isAgentHandoff(agent)) return;
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
    // After the ring includes this run: a burst of short-lived completions of
    // the SAME task type is a local diagnostic signal. A coordinator is parked
    // immediately; Layered Intelligence decides later whether it supports a
    // concrete planned fix.
    const churnModule = await import('../agentChurn.js').catch(() => {
      console.error('❌ 🔁 TaskLearning/CoS churn: Failed to load churn observer');
      return null;
    });
    if (!churnModule) return;
    await churnModule.observeAgentChurn(agent, task).catch(err => {
      console.error(`❌ 🔁 CoS churn: Failed to observe completion: ${err.message}`);
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
    // Same rule as the live listener above, and the reason it is repeated rather
    // than assumed: the backfill re-reads the ARCHIVE, where every relaunch the
    // live guard skipped is still sitting as a `success: false` record. Without
    // this, one backfill re-imports every phantom failure the listener refused.
    if (agent.status === 'completed' && agent.result && !isAgentHandoff(agent)) {
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
