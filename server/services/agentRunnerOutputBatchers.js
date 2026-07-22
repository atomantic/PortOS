/**
 * Per-agent debounced output batchers for the CoS Runner stream path.
 *
 * The runner emits `agent:output` per parsed line (see cos-runner/index.js), so
 * a chatty agent would otherwise trigger a full state load+save per line. Each
 * batcher coalesces a ~250ms window; we drain + drop it when the agent
 * completes/errors so the final lines persist before the completion event.
 *
 * Extracted from `subAgentSpawner.js` (issue #2837) so `agentManagement.js` can
 * import `flushRunnerOutputBatcher` statically. It previously reached for it via
 * `await import('./subAgentSpawner.js')` purely to dodge a cycle — the spawner
 * barrel re-exports agentManagement. Leaf module: only depends on the state
 * layer (`cosAgents.js`).
 */

import { createAgentOutputBatcher } from './cosAgents.js';

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
  // Flush BEFORE deleting: the agent is still in `runnerAgents` at this point
  // (handleAgentCompletion removes it afterwards), so a line racing in during
  // the awaited flush lands in this same batcher instead of orphaning a new
  // one. The `agent:output` guard in the spawner drops any truly
  // post-completion stray.
  await batcher.flush();
  runnerOutputBatchers.delete(agentId);
}
