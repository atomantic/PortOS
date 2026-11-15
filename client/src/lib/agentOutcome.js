/**
 * Client re-export of `server/lib/agentOutcome.js`: `isAgentHandoff(agent)` tells whether an agent
 * record was retired to hand its task to a continuation.
 *
 * Re-export of `server/lib/agentOutcome.js`: `isAgentHandoff(agent)` — `result.resumed === true` —
 * tells a record retired to hand its task to a continuation, a Resume or a provider Relaunch, from one
 * that reached a verdict, and `agentHandoffReason(agent)` gives the line such a card should show.
 * Cards reading `result.success` alone rendered a red "Failed" run for a swap the user made
 * deliberately, and the needs-feedback filter asked them to rate it. Imported rather than copied so
 * the run card and the daily report cannot disagree about whether a swap was a failure.
 * `normalizeTaskOutcome` validates explicit delivery evidence; `isTaskDeliveryComplete` admits
 * completed/no-action-needed delivery only, and the server also resolves reported evidence against
 * delivery checks with `resolveTaskOutcome`.
 */

/**
 * Is a completed agent record an OUTCOME, or a handoff to its own continuation?
 *
 * Re-export of `server/lib/agentOutcome.js` — the one definition of the rule,
 * imported rather than copied so the run card, the daily report and the weekly
 * digest cannot drift on whether a provider swap was a failure. The file stays so
 * every `lib/agentOutcome` import path in the client is unchanged.
 */
export { isAgentHandoff, agentHandoffReason, normalizeTaskOutcome, isTaskDeliveryComplete } from '../../../server/lib/agentOutcome.js';
