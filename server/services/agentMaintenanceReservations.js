/**
 * Release path for `agent` maintenance reservations that no lifecycle owner
 * will ever settle: the agent ended, was purged, or its owning process died.
 *
 * Leaf module (imports only the admission journal and pid probe) so both the
 * state layer and the process layer can call it without an import cycle.
 */
import { maintenance } from '../lib/maintenanceAdmission.js';
import { isPidAlive } from '../lib/heavyJobClaim.js';

/** Idempotent, never throws: a journal needing recovery must not abort the caller's terminal transition. */
export async function releaseAgentReservation(agentId) {
  try { await maintenance.finishResource('agent', agentId); }
  catch (err) { console.warn(`⚠️ Maintenance reservation for ${agentId} was not released: ${err.message}`); }
}

/**
 * Drop `agent` reservations whose agent is completed or no longer in state AND
 * whose admitting process is dead. A running/paused agent, a live owner pid and
 * an `unsettled` (uncertain-cleanup) record are never touched; operator
 * abandonment receipts stay the path for those.
 *
 * @param {{ agents: Array<{id: string, status?: string}>, admission?: object, pidAlive?: (pid:number)=>boolean }} input
 * @returns {Promise<number>} reservations released
 */
export async function reconcileStaleAgentReservations({ agents, admission = maintenance, pidAlive = isPidAlive }) {
  try {
    const statusById = new Map(agents.map(agent => [agent.id, agent.status]));
    const ended = id => !statusById.has(id) || statusById.get(id) === 'completed';
    const stale = admission.operations().filter(op => op.kind === 'agent' && !op.unsettled
      && ended(op.resource) && !pidAlive(op.pid));
    if (stale.length === 0) return 0;
    const released = admission.releaseOperations(stale);
    if (released > 0) console.log(`🧹 Released ${released} stale agent maintenance reservation(s)`);
    return released;
  } catch (err) {
    console.warn(`⚠️ Stale agent reservation reconcile skipped: ${err.message}`);
    return 0;
  }
}
