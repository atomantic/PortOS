/**
 * Per-agent debounced output batchers for the CoS Runner stream path.
 *
 * The runner emits `agent:output` per parsed line, so each batcher coalesces a
 * ~250ms window instead of a state load+save per line; it is drained and dropped
 * on completion/error so the final lines persist before the completion event.
 *
 * Leaf module (depends only on `cosAgentLifecycle.js`) so `agentManagement.js`
 * can import `flushRunnerOutputBatcher` statically without a cycle through the
 * spawner barrel.
 */

import { createAgentOutputBatcher } from './cosAgentLifecycle.js';

const runnerOutputBatchers = new Map();

export function getRunnerOutputBatcher(agentId) {
  let batcher = runnerOutputBatchers.get(agentId);
  if (!batcher) {
    batcher = createAgentOutputBatcher(agentId);
    runnerOutputBatchers.set(agentId, batcher);
  }
  return batcher;
}

export async function flushRunnerOutputBatcher(agentId) {
  const batcher = runnerOutputBatchers.get(agentId);
  if (!batcher) return;
  // Flush BEFORE deleting: the agent is still in `runnerAgents`, so a line racing
  // in during the awaited flush lands in this batcher instead of orphaning a new one.
  await batcher.flush();
  runnerOutputBatchers.delete(agentId);
}
