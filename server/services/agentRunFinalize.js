/**
 * The finalize sequence both in-process agent spawners share.
 *
 * The direct-CLI spawner's `handleClose` and the TUI spawner's `finish` end a
 * run through the same six steps — a paused early return, the host-shutdown
 * abandon gate, consuming the user-termination marker, deriving the final
 * success/error pair, and releasing the execution lane. They used to hold two
 * hand-mirrored copies of it, ~1,000 lines apart in two of the highest-churn
 * files in the tree, kept in sync by prose comments naming the other file — and
 * running their two gates in OPPOSITE order (#6619).
 *
 * The drift is not cosmetic. Skipping the paused return before
 * `releaseAgentLane` re-releases an already-released `executionId`, which the
 * lane bookkeeping records as a spurious "Invalid state transition"; skipping
 * the `userTerminatedAgents` consume records a run the user killed as a success
 * while its task stays blocked. `shouldAbandonForHostShutdown`
 * (`../lib/hostShutdown.js`) is the precedent — exactly this class of shared
 * decision, extracted after #3202. This is the rest of that sequence.
 *
 * Canonical order: **the paused return runs before the abandon gate.** A paused
 * run can then never reach the abandon path even if `shouldAbandonForHostShutdown`
 * later stops taking `paused`, which makes that argument redundant rather than
 * load-bearing — so neither spawner passes it any more.
 */

import { activeAgents, userTerminatedAgents, pausedAgents, consumePausedAgentExit, unregisterSpawnedAgent } from './agentState.js';
import { releaseAgentLane } from './agentFinalization.js';
import { shouldAbandonForHostShutdown } from '../lib/hostShutdown.js';

/** Recorded on a run the user killed, whatever exit code the process reported. */
export const USER_TERMINATED_ERROR = 'Agent terminated by user';

/**
 * Should this exit be preserved for restart recovery instead of finalized?
 *
 * Wraps `shouldAbandonForHostShutdown` with the canonical precedence: a paused
 * run is never abandoned (it has its own don't-finalize path, which owns the
 * paused bookkeeping), and the user-termination marker is read from the live
 * registry rather than passed in, so both call sites cannot disagree about it.
 *
 * Exported for the TUI path, which must consult the gate BEFORE its sentinel
 * ingest / merge-gate check — work that must not run while the host is going
 * down. Everything after that point goes through `finalizeAgentRunCommon`.
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
 * Run the shared finalize sequence and report which path the run took.
 *
 * On `'finalize'` the execution lane has already been released — deliberately
 * BEFORE the caller's error-analysis / state-write chain, since neither call
 * blocks on I/O but lanes serialize related work. `'paused'` and `'abandoned'`
 * release nothing; the caller returns without finalizing, doing only its own
 * teardown (the TUI's `abandonForHostShutdown`, the CLI's inline equivalent).
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {object|null} [params.agentData] - the `activeAgents` record, when the
 *   caller already looked it up; its `executionId`/`laneName`/`pid` win over the
 *   outer-scope fallbacks, which cover an entry cleared before the exit landed.
 * @param {boolean} [params.success] - the caller's verdict BEFORE the
 *   user-termination override (the CLI folds its sentinel/fallback reading in).
 * @param {string|null} [params.error] - the caller's error, same proviso.
 * @param {number|null} [params.exitCode]
 * @param {number} [params.duration]
 * @param {string|null} [params.executionId] - outer-scope fallback
 * @param {string|null} [params.laneName] - outer-scope fallback
 * @param {boolean} [params.sentinelPresent] - the run wrote its own `.agent-done`
 * @param {string} [params.errorExecutionFallback] - execution-tracking message for
 *   a run that failed without one of its own
 * @returns {{outcome: 'paused'}
 *   | {outcome: 'abandoned'}
 *   | {outcome: 'finalize', finalSuccess: boolean, finalError: string|null, terminatedByUser: boolean}}
 */
export function finalizeAgentRunCommon({
  agentId,
  agentData = null,
  success = false,
  error = null,
  exitCode = null,
  duration = 0,
  executionId = null,
  laneName = null,
  sentinelPresent = false,
  errorExecutionFallback = undefined,
}) {
  // Paused agents were already finalized by `markAgentPaused`, which released
  // the lane + execution. Return BEFORE `releaseAgentLane` below — re-running it
  // on the same executionId logs a spurious "Invalid state transition".
  if (pausedAgents.has(agentId)) {
    consumePausedAgentExit(agentId);
    // Prefer the live registry (the TUI reads it here) and fall back to the
    // caller's record for an entry `killAgent` cleared before the exit landed.
    const pid = activeAgents.get(agentId)?.pid ?? agentData?.pid;
    if (pid) unregisterSpawnedAgent(pid);
    activeAgents.delete(agentId);
    return { outcome: 'paused' };
  }

  // PortOS is going down and took this child with it (pm2's TreeKill walks
  // portos-server's descendants). Abandoning rather than finalizing is what
  // keeps the interruption from being written down as an outcome — finalizing
  // would charge the task's failure budget for a fault the agent didn't have,
  // and its cleanup hands the worktree to `cleanupAgentWorktree`, discarding the
  // state a resume needs. The caller leaves the record `running` so the next
  // boot's orphan sweep can requeue it from the host-shutdown marker (#3202).
  if (shouldAbandonAgentRun({ agentId, sentinelPresent })) {
    return { outcome: 'abandoned' };
  }

  const terminatedByUser = userTerminatedAgents.has(agentId);
  if (terminatedByUser) userTerminatedAgents.delete(agentId);

  // Force failure on a user-terminated run even when the process happened to
  // exit 0 in the race window — otherwise it is recorded as successful while
  // the task remains blocked.
  const finalSuccess = terminatedByUser ? false : success;
  const finalError = terminatedByUser ? USER_TERMINATED_ERROR : error;

  releaseAgentLane({
    agentId,
    success: finalSuccess,
    duration,
    exitCode,
    executionId: agentData?.executionId || executionId,
    laneName: agentData?.laneName || laneName,
    errorExecutionMessage: finalError || errorExecutionFallback,
  });

  return { outcome: 'finalize', finalSuccess, finalError, terminatedByUser };
}
