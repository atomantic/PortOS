/**
 * Is a completed agent record an OUTCOME, or a handoff to its own continuation?
 *
 * Re-export of `server/lib/agentOutcome.js` — the one definition of the rule,
 * imported rather than copied so the run card, the daily report and the weekly
 * digest cannot drift on whether a provider swap was a failure. The file stays so
 * every `lib/agentOutcome` import path in the client is unchanged.
 */
export { isAgentHandoff, agentHandoffReason } from '../../../server/lib/agentOutcome.js';
