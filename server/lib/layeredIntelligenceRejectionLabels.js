// Human-readable gloss for the Layered Intelligence proposal-rejection taxonomy
// (#2689). A pure leaf so the server (prompt blocks) and the client (outcomes
// dashboard) read ONE table. Keys are the REJECTION_REASONS tokens plus the
// `unknown-reason` sentinel from services/layeredIntelligenceRejections.js.
export const REJECTION_REASON_LABELS = Object.freeze({
  'duplicate': 'already tracked elsewhere (duplicate)',
  'user-rejected': 'the user declined it (closed as not planned)',
  'scope-mismatch': "outside the app's scope",
  'missing-context': 'missing context the proposal should have supplied',
  'quality-issue': 'the proposal itself was low quality or malformed',
  'environment-blocker': 'blocked on the environment or a dependency',
  'merge-conflict': 'the implementing change could not be merged',
  'validation-failed': 'the implementing change failed lint/validation',
  'unknown-reason': 'closed with no recorded reason'
});
