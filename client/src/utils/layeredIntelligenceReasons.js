// Canonical gloss for the Layered Intelligence loop's run-outcome reason tokens.
//
// The reason vocabulary is authored server-side (server/services/autonomousJobs/
// layeredIntelligenceHooks.js — `no-provider`, `unparseable-response`,
// `no-proposal`, `scope-suppressed`, `file-failed`, `duplicate`,
// `semantic-duplicate`, `tracker-read-failed`, `blocking-read-failed`,
// `jira-not-configured`, `provider-not-agent-capable`, `blocking-open`, plus the
// synthesized `llm-error:<msg>`
// prefix) and consumed by BOTH the on-demand toast (useOnDemandTaskToast) and the
// durable "Last run" status line (LayeredIntelligenceTab). Keeping the token→prose
// map here — not forked per component — means a new server reason has exactly ONE
// place to add its gloss, and a missing one degrades to the raw token in one spot
// rather than silently rendering three different ways.

// Reasons that are a normal, non-alarming outcome (a run that simply had nothing
// new to file) — rendered in a neutral tone rather than a warning.
export const LI_NEUTRAL_REASONS = new Set([
  'no-proposal', 'duplicate', 'semantic-duplicate', 'blocking-open'
]);

const LI_REASON_LABELS = {
  'no-provider': 'no AI provider is configured for it',
  'unparseable-response': 'the reasoning model returned no usable JSON — try a non-reasoning model or an API provider',
  'no-proposal': 'the loop had nothing to propose',
  'scope-suppressed': "the proposal's scope isn't allowed for this app",
  'file-failed': 'filing the tracker issue failed',
  'duplicate': 'the proposal matched an existing open issue',
  'semantic-duplicate': 'the proposal closely matched an existing issue',
  'tracker-read-failed': "couldn't read the issue tracker — it'll retry next run",
  'blocking-read-failed': "couldn't read blocking issues — it'll retry next run",
  'jira-not-configured': "Jira isn't fully configured for this app",
  'provider-not-agent-capable': 'the selected provider is an API-only model with no coding harness — pick a CLI/TUI provider (e.g. the Claude Ollama sample) for the reasoning agent'
};

const LLM_ERROR_PREFIX = 'llm-error:';

// Turn a handler outcome (action + reason [+ open blocking count]) into one
// sentence. Handles the two synthesized shapes — the `llm-error:<msg>` prefix (the
// provider threw) and `blocking-open`/parked (an open blocking issue, with an
// optional count only the toast carries) — then falls back to the reason gloss.
export function formatLiReason({ action = null, reason = null, blocking = null } = {}) {
  if (typeof reason === 'string' && reason.startsWith(LLM_ERROR_PREFIX)) {
    return `the AI provider errored —${reason.slice(LLM_ERROR_PREFIX.length)}`.trimEnd();
  }
  if (reason === 'blocking-open' || action === 'parked') {
    const n = typeof blocking === 'number' && blocking > 0 ? ` (${blocking} open)` : '';
    return `paused on a blocking issue${n} — resolve or unblock it to resume`;
  }
  if (action === 'in-flight') return 'a previous run is still in progress — try again shortly';
  return LI_REASON_LABELS[reason] || reason || 'it produced no proposal';
}

// Status-line tone for a NON-filed outcome: error for a provider/runtime throw,
// neutral for a "nothing new" run, warning for the rest (a filed run is success —
// the caller owns that, since it also renders the filed ref).
export function liReasonTone(reason = null) {
  if (typeof reason === 'string' && reason.startsWith(LLM_ERROR_PREFIX)) return 'error';
  if (LI_NEUTRAL_REASONS.has(reason)) return 'neutral';
  return 'warn';
}

// The proposal-REJECTION taxonomy (#2689) — WHY a filed proposal ended up not
// merged. Distinct vocabulary from the run-reason tokens above: those explain why a
// LOOP RUN produced no proposal, these explain why a FILED proposal was rejected.
// Mirrors the server gloss (REJECTION_REASON_LABELS in
// server/services/layeredIntelligenceRejections.js) so the outcomes dashboard reads
// the same as the reasoner prompt. Keep in lockstep; an unknown token degrades to
// itself. `unknown-reason` is the honest "we classified it and found no signal"
// sentinel — a real answer, not a gap.
const LI_REJECTION_REASON_LABELS = {
  'duplicate': 'already tracked elsewhere (duplicate)',
  'user-rejected': 'the user declined it (closed as not planned)',
  'scope-mismatch': "outside the app's scope",
  'missing-context': 'missing context the proposal should have supplied',
  'quality-issue': 'the proposal itself was low quality or malformed',
  'environment-blocker': 'blocked on the environment or a dependency',
  'merge-conflict': 'the implementing change could not be merged',
  'validation-failed': 'the implementing change failed lint/validation',
  'unknown-reason': 'closed with no recorded reason'
};

// Gloss one rejection-reason token as prose. A nullish input renders as '' (not
// classified — nothing to say); an unglossed token passes through.
export function formatLiRejectionReason(reason = null) {
  if (!reason) return '';
  return LI_REJECTION_REASON_LABELS[reason] || reason;
}
