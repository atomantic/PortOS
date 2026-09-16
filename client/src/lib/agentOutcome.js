/**
 * Is a completed agent record an OUTCOME, or a handoff to its own continuation?
 *
 * Client mirror of `server/lib/agentOutcome.js` — same contract, same key. Read
 * that file for why the rule exists; the short version is that Relaunch (and
 * Resume) retire the old record with `success: false` and requeue the SAME task,
 * usually because the user swapped providers after a CLI hit a usage limit. Cards
 * that render `result.success` alone therefore showed a red "Failed" run for a
 * swap the user made deliberately, and the feedback prompt asked them to rate it.
 *
 * Mirrored rather than imported: `client/src/lib` must not reach into the server
 * tree (a client-side import of a server module pulls its whole closure into the
 * browser bundle and into every suite that renders one of these cards). Keep the
 * two in step — `agentOutcome.test.js` on each side pins the shared contract.
 */

/**
 * True when this record was retired to hand its task to a continuation run
 * (Resume / Relaunch) rather than because the run reached a verdict.
 */
export function isAgentHandoff(agent) {
  return agent?.result?.resumed === true;
}

/** True when the run reached a real verdict — the only records worth counting. */
export function isAgentOutcome(agent) {
  return !!agent?.result && !isAgentHandoff(agent);
}

/** True when the run genuinely failed: a verdict was reached and it was negative. */
export function isAgentFailure(agent) {
  return isAgentOutcome(agent) && agent.result.success !== true;
}
