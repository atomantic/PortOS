/**
 * Layered Intelligence execution-FAILURE taxonomy + classifier: WHY a handed-off proposal
 * failed (planning / execution / testing / context / scope), complementing the binary
 * success rate in `computeExecutionByDomain`.
 *
 * Pure, no I/O. A LEAF module (no LI-graph imports) so it can't create a cycle. Mirrors
 * `layeredIntelligenceRejections.js`. Only NON-ENVIRONMENTAL failures reach here
 * (`taskLearning/metrics.js` nulls the payload for rate-limit / outage / auth). Tally and render
 * live in `lib/taxonomyTally.js`.
 */

import {
  normalizeToken,
  formatTaxonomyToken,
  createTaxonomyTally
} from '../lib/taxonomyTally.js';

// Persisted contract (outcome record + reasoner prompt): renaming a token makes old records fail
// the sanitizer's membership check and coerce to null, so prefer ADDING.
// planning: under-defined/already done; execution: mechanically wrong; testing: broke a project
// check; context: lacked repo knowledge/budget; scope: outside autonomous reach.
export const EXECUTION_FAILURE_CATEGORIES = [
  'planning',
  'execution',
  'testing',
  'context',
  'scope'
];

/**
 * The "classified, and no signal explained it" sentinel. NOT a member of
 * EXECUTION_FAILURE_CATEGORIES: it is the ABSENCE of a diagnosis. Distinct from a `null`
 * failureCategory ("not classified yet / not a failure"); conflating them would hide the data
 * gap this taxonomy measures or re-classify the same record forever.
 */
export const UNKNOWN_EXECUTION_FAILURE = 'unknown-failure';

export const EXECUTION_FAILURE_VALUES = [...EXECUTION_FAILURE_CATEGORIES, UNKNOWN_EXECUTION_FAILURE];

const EXECUTION_FAILURE_LABELS = {
  planning: 'the task was under-defined or already done (no correct change to make)',
  execution: 'the agent applied the change incorrectly',
  testing: 'the change broke a test / lint / build check (a regression)',
  context: 'the agent lacked repo knowledge or ran out of context',
  scope: "the work was outside an autonomous agent's reach here",
  [UNKNOWN_EXECUTION_FAILURE]: 'failed with no recognized cause'
};

/**
 * Render one token as prose. A nullish (unclassified) input renders as '' — mapping it onto
 * the sentinel would present "not classified" as "classified, found nothing".
 */
export function formatExecutionFailure(category) {
  return formatTaxonomyToken(category, EXECUTION_FAILURE_LABELS);
}

// Raw agentErrorAnalysis category → taxonomy. Keys are the `category` tokens from
// server/services/agent/agentErrorAnalysis.js plus the `hook-error` / `unparseable-response` tokens
// the LI hook path can raise. Deliberately conservative: a raw category with no confident home
// is LEFT OUT so it falls through to `unknown-failure`.
//
// ENVIRONMENTAL categories (rate-limit, usage-limit, auth-error, forbidden, billing-error,
// server-error, network-error, startup-failure, timeout, claude-error, model-not-found/
// -not-supported) are intentionally ABSENT: they are filtered upstream (isEnvironmentalFailure)
// and say nothing about LI's capability.
const RAW_CATEGORY_TAXONOMY = new Map(Object.entries({
  // A clean-exit validation miss is not a raw errorCategory; classifyExecutionFailure handles it
  // via `validationPassed === false`.
  'test-failure': 'testing',
  'lint-error': 'testing',
  'build-error': 'testing',
  'npm-error': 'testing',

  'git-conflict': 'execution',
  'git-error': 'execution',
  'tool-error': 'execution',
  'mcp-error': 'execution',
  'parse-error': 'execution',
  'locator-error': 'execution',
  'browser-error': 'execution',
  'process-killed': 'execution',
  'spawn-error': 'execution',
  'memory-error': 'execution',
  'hook-error': 'execution',
  'unparseable-response': 'execution',

  'context-length': 'context',
  'ollama-context-window': 'context',
  'output-length': 'context',
  'turn-limit': 'context',
  'file-not-found': 'context',

  'task-rejected': 'scope',
  'content-filtered': 'scope',
  'permission-denied': 'scope',
  'bad-request': 'scope',

  'no-changes': 'planning'
}));

/**
 * Classify WHY a handed-off LI proposal FAILED to execute.
 *
 * Returns:
 *   - `null` when the execution did NOT fail (never invent a category for a success).
 *   - an EXECUTION_FAILURE_CATEGORIES token when a signal supports it.
 *   - UNKNOWN_EXECUTION_FAILURE when the run failed but no signal explains it: a measured gap
 *     that must never be dressed up as a real cause.
 *
 * Precedence: a mapped raw `errorCategory`, then `validationPassed === false` → `testing`.
 * Callers pass `success` unconditionally. To re-classify a stored record, pass
 * `{ success: false, errorCategory: record.failureSignal }`.
 */
export function classifyExecutionFailure({ success, errorCategory = null, validationPassed = null } = {}) {
  if (success !== false) return null;

  const mapped = RAW_CATEGORY_TAXONOMY.get(normalizeToken(errorCategory));
  if (mapped) return mapped;

  if (validationPassed === false) return 'testing';

  return UNKNOWN_EXECUTION_FAILURE;
}

const executionFailureTally = createTaxonomyTally({
  predicate: (o) => o.executionOutcome === 'failure',
  select: (o) => o.failureCategory,
  field: 'category',
  vocabulary: EXECUTION_FAILURE_CATEGORIES,
  sentinel: UNKNOWN_EXECUTION_FAILURE,
  glossFn: formatExecutionFailure,
  gapWording: {
    unknown: (n, total) => `${n} of ${total} failed with no recognized cause`,
    unclassified: (n, total) => `${n} of ${total} not yet classified`
  }
});

/**
 * Tally execution-failure categories across every FAILED-execution record (successes and
 * never-handed-off records are not counted).
 *
 * Returns `{ entries, unknown, unclassified, diagnosed, total }`, same shape as
 * summarizeRejectionReasons:
 *   - `entries`      — `[{ category, count }]` of REAL diagnoses only, commonest first.
 *   - `unknown`      — classified `unknown-failure`: a MEASURED gap.
 *   - `unclassified` — failed with no valid category stored (older record or a path that passed
 *                      no signal): an UNMEASURED gap with a different remedy.
 *   - `diagnosed`    — sum of `entries`.
 *   - `total`        — every failed-execution record; `0` means only "no hand-off has failed".
 *
 * `unknown`/`unclassified` stay OUT of `entries` so they can't crowd real diagnoses out of a
 * top-N list.
 */
export function summarizeExecutionFailures(outcomes = []) {
  return executionFailureTally.summarize(outcomes);
}

/**
 * Render a tally as one prompt line: the commonest `limit` diagnoses, glossed, then any
 * non-zero gaps. Returns '' ONLY when no hand-off has failed; it must not fall silent merely
 * because failures are undiagnosed.
 */
export function formatExecutionFailures(outcomes = [], limit = 3) {
  return executionFailureTally.format(outcomes, limit);
}
