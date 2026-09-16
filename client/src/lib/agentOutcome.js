/**
 * Is a completed agent record an OUTCOME, or a handoff to its own continuation?
 *
 * Client mirror of `server/lib/agentOutcome.js` — same contract, same key, and
 * pinned to it by `server/lib/agentOutcome.parity.test.js`. Read that file for
 * why the rule exists; the short version is that Relaunch (and Resume) retire the
 * old record with `success: false` and requeue the SAME task, usually because the
 * user swapped providers after a CLI hit a usage limit. Surfaces that render
 * `result.success` alone therefore showed a red "Failed" run for a swap the user
 * made deliberately, and the feedback prompt asked them to rate it.
 *
 * Mirrored rather than imported: `client/src/lib` must not reach into the server
 * tree (a client-side import of a server module pulls its whole closure into the
 * browser bundle and into every suite that renders one of these cards).
 */

/**
 * True when this record was retired to hand its task to a continuation run
 * (Resume / Relaunch) rather than because the run reached a verdict.
 *
 * STRICT equality on purpose — see the server copy for why.
 */
export function isAgentHandoff(agent) {
  return agent?.result?.resumed === true;
}

/**
 * The one line a handoff card should show: WHAT THE USER CHANGED.
 *
 * `metadata.pauseReason` first, because on a Relaunch that is the sentence the
 * user is looking for ("Relaunched by user on codex / gpt-5"), while
 * `result.error` holds `resumeAgent`'s summary — which says where the TASK went,
 * not why this run stopped. Client-only: nothing server-side renders it, and
 * keeping it out of the mirrored half is what keeps the parity test a one-line
 * contract.
 */
export function agentHandoffReason(agent) {
  return agent?.metadata?.pauseReason || agent?.result?.error || 'Handed off to a new run';
}
