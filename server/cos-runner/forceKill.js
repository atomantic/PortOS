/** The runner's SIGTERM → grace → SIGKILL escalation; lives apart from `index.js`, which binds a socket server at import. */

import { killProcessTree } from '../lib/bufferedSpawn.js';

/**
 * Arm the force-kill escalation for an agent that was just signalled. Dropping the map entry
 * when the grace expires keeps `GET /agents` honest (a process outliving SIGKILL must not stay
 * advertised). A fresh termination always re-arms: a spent timer left by `/pause` must not
 * swallow a later `/terminate`. `dropState` also clears the durable runner record, only for a
 * kill relayed for an already-finalized agent, never a paused one (resume reads it).
 * @param {Map<string, object>} activeAgents - the runner's live-agent map
 * @param {string} agentId
 * @param {object} agent - the map entry (its `process` is the killable)
 * @param {{ graceMs: number, dropState?: boolean, onDropState?: (agentId: string) => void }} opts
 */
export function armForceKill(activeAgents, agentId, agent, { graceMs, dropState = false, onDropState } = {}) {
  if (agent.killTimer) clearTimeout(agent.killTimer);
  agent.killTimer = setTimeout(() => {
    // Timer callback: a throw has no request to bubble to and would crash the runner.
    try {
      agent.killTimer = null;
      if (!activeAgents.delete(agentId)) return;
      console.log(`💀 Agent ${agentId} outlived its termination grace — force killing`);
      killProcessTree(agent.process, 'SIGKILL');
      if (dropState) onDropState?.(agentId);
    } catch (err) {
      console.error(`❌ Force kill failed for ${agentId}: ${err.message}`);
    }
  }, graceMs);
  return agent.killTimer;
}
