/**
 * The finalize sequence both in-process agent spawners share.
 *
 * Shared by the direct-CLI `handleClose` and the TUI `finish` (#6619). Skipping the
 * paused return finalizes a paused run; skipping the
 * `userTerminatedAgents` consume records a killed run as a success. Canonical
 * order: **the paused return runs before the abandon gate**.
 */

import { activeAgents, userTerminatedAgents, pausedAgents, consumePausedAgentExit, unregisterSpawnedAgent } from './agentState.js';
import { shouldAbandonForHostShutdown } from '../../lib/hostShutdown.js';

/** Recorded on a run the user killed, whatever exit code the process reported. */
export const USER_TERMINATED_ERROR = 'Agent terminated by user';

/**
 * Should this exit be preserved for restart recovery instead of finalized?
 * A paused run is never abandoned; the user-termination marker is read from the
 * live registry. Exported for the TUI path, which must consult the gate BEFORE
 * its sentinel ingest / merge-gate check.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {boolean} [params.sentinelPresent] - the run wrote its own `.agent-done`
 * @returns {boolean}
 */
export function shouldAbandonAgentRun({ agentId, sentinelPresent = false }) {
  if (pausedAgents.has(agentId)) return false;
  return shouldAbandonForHostShutdown({
    sentinelPresent,
    terminatedByUser: userTerminatedAgents.has(agentId),
  });
}

/**
 * Run the shared finalize sequence and report which path the run took. `'paused'`
 * and `'abandoned'` leave the record for the caller.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {object|null} [params.agentData] - the `activeAgents` record; its pid backs up the registry
 * @param {boolean} [params.success] - the caller's verdict BEFORE the user-termination override
 * @param {string|null} [params.error] - the caller's error, same proviso.
 * @param {boolean} [params.sentinelPresent] - the run wrote its own `.agent-done`
 * @returns {{outcome: 'paused'}
 *   | {outcome: 'abandoned'}
 *   | {outcome: 'finalize', finalSuccess: boolean, finalError: string|null, terminatedByUser: boolean}}
 */
export function finalizeAgentRunCommon({
  agentId,
  agentData = null,
  success = false,
  error = null,
  sentinelPresent = false,
}) {
  if (pausedAgents.has(agentId)) {
    consumePausedAgentExit(agentId);
    // Fall back to the caller's record for an entry `killAgent` cleared early.
    const pid = activeAgents.get(agentId)?.pid ?? agentData?.pid;
    if (pid) unregisterSpawnedAgent(pid);
    activeAgents.delete(agentId);
    return { outcome: 'paused' };
  }

  // PortOS is going down and took this child with it. Finalizing would charge the
  // task's failure budget for a fault the agent didn't have and discard the
  // worktree a resume needs; the caller leaves the record `running` so the next
  // boot's orphan sweep requeues it (#3202).
  if (shouldAbandonAgentRun({ agentId, sentinelPresent })) {
    return { outcome: 'abandoned' };
  }

  const terminatedByUser = userTerminatedAgents.has(agentId);
  if (terminatedByUser) userTerminatedAgents.delete(agentId);

  // Force failure on a user-terminated run even if the process exited 0 in the race.
  const finalSuccess = terminatedByUser ? false : success;
  const finalError = terminatedByUser ? USER_TERMINATED_ERROR : error;


  return { outcome: 'finalize', finalSuccess, finalError, terminatedByUser };
}
