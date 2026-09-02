/**
 * The runner's SIGTERM → grace → SIGKILL escalation.
 *
 * Every termination path in `index.js` is graceful-then-forced: `killProcessTree`
 * decides what "kill" means for the agent's handle (a `taskkill /T /F` tree for a
 * cmd.exe-wrapped CLI shim, #2243; a signal-free node-pty kill on Windows), and
 * this is the grace window after it.
 *
 * Lives in its own module because `index.js` binds a socket server at import and
 * can only be inspected as source text — and the stale-timer bug below was
 * invisible to exactly that kind of test.
 */

import { killProcessTree } from '../lib/bufferedSpawn.js';

/**
 * Arm the force-kill escalation for an agent that was just signalled.
 *
 * Dropping the map entry when the grace expires is what keeps `GET /agents`
 * honest: a process that outlives its own SIGKILL must not go on being
 * advertised as an active run, or the PortOS server re-adopts it on every orphan
 * sweep and counts it against the Update page's "N CoS agents running" gate.
 *
 * **A fresh termination always re-arms**, replacing any timer already on the
 * agent. Refusing to arm because `killTimer` was truthy would let a *spent*
 * timer — `/pause` leaves its own behind, and it neither clears the handle nor
 * removes the map entry — swallow the escalation for a later `/terminate`,
 * stranding the very phantom this exists to reap. The callback clears the handle
 * so a settled timer never looks armed.
 *
 * `dropState` also clears the durable runner record. It belongs only to a kill
 * relayed for an agent the PortOS server has ALREADY finalized, where nothing
 * will ever revisit either copy — never to a paused agent, whose record is what
 * a later resume reads.
 *
 * @param {Map<string, object>} activeAgents - the runner's live-agent map
 * @param {string} agentId
 * @param {object} agent - the map entry (its `process` is the killable)
 * @param {{ graceMs: number, dropState?: boolean, onDropState?: (agentId: string) => void }} opts
 */
export function armForceKill(activeAgents, agentId, agent, { graceMs, dropState = false, onDropState } = {}) {
  if (agent.killTimer) clearTimeout(agent.killTimer);
  agent.killTimer = setTimeout(() => {
    // Timer callback: an uncaught throw here has no request to bubble to and
    // would take the whole runner down.
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
