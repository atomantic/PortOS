/**
 * Layered Intelligence execution-FAILURE taxonomy + classifier (#2764 §1).
 *
 * `computeExecutionByDomain` / `computeProposalExecutionAwareness` (#2765) answer
 * *how often* LI's own hand-offs succeed per domain — a binary success/failure
 * rate. They do not answer *why* an execution failed. Today the outcome store's
 * `executionOutcome` slot holds only `'success'` / `'failure'`, so when the
 * reasoner is told "LI implemented 0% of its loop-meta proposals" it learns the
 * gap exists but nothing about its shape — planning? a regression? missing repo
 * context? — which is exactly the signal needed to decide whether to narrow a
 * proposal, defer it, or route it elsewhere.
 *
 * This module owns the structured vocabulary for that "why" and the deterministic
 * mapping onto it. Pure, no I/O, no LLM call: the classification is derived from
 * the failure signal the task-learning layer ALREADY computed for the run
 * (`errorCategory` from agentErrorAnalysis's pattern sweep, plus the
 * validation-authoritative `validationPassed`), so it adds no provider round-trip
 * (the "no cold-bootstrap LLM calls" policy) and no extra work at the recording
 * site.
 *
 * A LEAF module by design — it imports nothing from the LI graph — so both
 * `layeredIntelligence.js` (which formats the report) and
 * `layeredIntelligenceOutcomes.js` (which persists the classification) can use it
 * without an import cycle. It intentionally mirrors the shape of its sibling
 * `layeredIntelligenceRejections.js` (the proposal-REJECTION taxonomy): same
 * three-valued sentinel discipline, same "diagnosed / unknown / unclassified"
 * split, same bounded prompt-line renderer.
 *
 * SCOPE NOTE. Only NON-ENVIRONMENTAL failures ever reach this classifier: the
 * recording site (`taskLearning/metrics.js`) already nulls the LI execution
 * payload for environmental failures (rate-limit / outage / auth), so a
 * provider-outage category never lands here and never dents a domain's failure
 * shape. The remaining raw categories describe how LI's OWN implementation attempt
 * went wrong — which is what this taxonomy classifies.
 *
 * The tally + top-N-line render engine (the commonest-first sort with a
 * taxonomy-order tie-break, the three-bucket `{entries, unknown, unclassified,
 * diagnosed, total}` discipline, and `normalizeToken`) lives in the shared leaf
 * `lib/taxonomyTally.js` (#2800); this module supplies only the vocabulary, gloss
 * map, and classifier.
 */

import {
  normalizeToken,
  formatTaxonomyToken,
  createTaxonomyTally
} from '../lib/taxonomyTally.js';

// The execution-failure vocabulary (#2764 §1). Stored on the outcome record and
// rendered into the reasoner's prompt, so these tokens are a persisted contract:
// rename one and old records fail the sanitizer's membership check and coerce to
// null (re-derived on the next execution write) — prefer ADDING over renaming.
//
// The five categories are the ones #2764 §1 names, each defined by the QUESTION it
// answers about a failed hand-off:
export const EXECUTION_FAILURE_CATEGORIES = [
  // The task/proposal was under-defined or already satisfied — the agent had
  // nothing correct to do (e.g. it produced no changes). A signal to write a
  // sharper, smaller proposal body, not to try harder.
  'planning',
  // The agent attempted the change but got it mechanically wrong — a merge
  // conflict, a malformed edit, a tool/subprocess failure while applying it.
  'execution',
  // The change was made but broke something the project checks — a failing test,
  // a lint/build break, or a missed validation criterion (a regression).
  'testing',
  // The agent lacked repo knowledge it needed — an expected file wasn't there, or
  // the task overran the context/turn budget gathering what it needed to know.
  'context',
  // The work was outside what an autonomous agent could do here — it declined the
  // task, tripped a content filter, or hit a permission boundary. A signal to keep
  // this kind of proposal for a human rather than hand it off.
  'scope'
];

/**
 * The explicit "we classified this failure and no signal explained it" sentinel.
 * NOT a member of EXECUTION_FAILURE_CATEGORIES: it is the ABSENCE of a diagnosis,
 * not a diagnosis. Kept distinct from a `null` failureCategory, which means "not
 * classified yet / not a failure" — conflating the two would either hide the data
 * gap this taxonomy exists to measure or re-classify the same record forever. See
 * sanitizeOutcomeRecord.
 */
export const UNKNOWN_EXECUTION_FAILURE = 'unknown-failure';

// Every value the store may legitimately hold in `failureCategory` for a failed
// execution.
export const EXECUTION_FAILURE_VALUES = [...EXECUTION_FAILURE_CATEGORIES, UNKNOWN_EXECUTION_FAILURE];

// Human-readable gloss, used to render the prompt line. A token with no gloss
// degrades to the raw token rather than being dropped.
const EXECUTION_FAILURE_LABELS = {
  planning: 'the task was under-defined or already done (no correct change to make)',
  execution: 'the agent applied the change incorrectly',
  testing: 'the change broke a test / lint / build check (a regression)',
  context: 'the agent lacked repo knowledge or ran out of context',
  scope: "the work was outside an autonomous agent's reach here",
  [UNKNOWN_EXECUTION_FAILURE]: 'failed with no recognized cause'
};

/**
 * Render one token as prose for the reasoner. An unglossed token passes through;
 * a nullish (unclassified) input renders as '' — mapping it onto the sentinel
 * would invert the module's central rule by dressing "not classified" up as
 * "classified, and we found nothing".
 */
export function formatExecutionFailure(category) {
  return formatTaxonomyToken(category, EXECUTION_FAILURE_LABELS);
}

// Raw agentErrorAnalysis category → execution-failure taxonomy. Every key is one of
// the `category` tokens ERROR_PATTERNS / analyzeAgentFailure produces
// (server/services/agentErrorAnalysis.js), plus the validation-authoritative
// `hook-error` / `unparseable-response` tokens the LI hook path can raise. The
// mapping is deliberately conservative — a raw category with no confident home is
// LEFT OUT so it falls through to the honest `unknown-failure` rather than being
// forced into a bucket it doesn't belong in (the same "a miss is the correct
// failure" discipline the rejection classifier uses).
//
// ENVIRONMENTAL categories (rate-limit, usage-limit, auth-error, forbidden,
// billing-error, server-error, network-error, startup-failure, timeout,
// claude-error, model-not-found/-not-supported) are intentionally ABSENT: they are
// filtered out upstream (isEnvironmentalFailure → null LI payload) and say nothing
// about LI's own capability, so on the off chance one arrives it correctly reads as
// `unknown-failure` rather than a real capability signal.
const RAW_CATEGORY_TAXONOMY = new Map(Object.entries({
  // testing — the change was made but broke a project check (a regression). Note a
  // clean-exit VALIDATION MISS is not a raw errorCategory token (it's only ever a
  // synthetic `failed:validation-miss` display label), so it is handled by the
  // `validationPassed === false → testing` branch in classifyExecutionFailure, not here.
  'test-failure': 'testing',
  'lint-error': 'testing',
  'build-error': 'testing',
  'npm-error': 'testing',

  // execution — the agent got the mechanical application of the change wrong.
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

  // context — the agent lacked repo knowledge, or overran the context/turn budget.
  'context-length': 'context',
  'output-length': 'context',
  'turn-limit': 'context',
  'file-not-found': 'context',

  // scope — the work was outside what an autonomous agent could do here.
  'task-rejected': 'scope',
  'content-filtered': 'scope',
  'permission-denied': 'scope',
  'bad-request': 'scope',

  // planning — the task was under-defined or already satisfied.
  'no-changes': 'planning'
}));

/**
 * Classify WHY a handed-off LI proposal FAILED to execute (#2764 §1).
 *
 * Returns:
 *   - `null` when the execution did NOT fail — a success, or nothing to diagnose.
 *     Never invent a failure category for a successful run.
 *   - an EXECUTION_FAILURE_CATEGORIES token when a signal supports it.
 *   - UNKNOWN_EXECUTION_FAILURE when the run demonstrably failed but no signal
 *     explains it. This is the honest answer and a measured gap ("how much of our
 *     execution-failure history is undiagnosed"), so it must never be silently
 *     dressed up as a real cause.
 *
 * Signal precedence (most authoritative first):
 *   1. the raw `errorCategory` (agentErrorAnalysis's pattern sweep) when it maps to
 *      a taxonomy token — the most specific evidence available;
 *   2. `validationPassed === false` → `testing`: the run exited without a
 *      recognized error but missed its declared validation criterion, which is a
 *      regression/validation failure even though no error pattern matched (the
 *      validation-miss case the raw category can't express when errorCategory is
 *      null).
 * Anything else falls through to `unknown-failure`.
 *
 * The classifier owns the "null when there is nothing to diagnose" rule (mirroring
 * classifyRejection returning null for a merged/unresolved proposal), so callers
 * pass the run's `success` flag unconditionally rather than pre-guarding. To
 * re-classify a stored failed record from its retained raw signal, pass
 * `{ success: false, errorCategory: record.failureSignal }`.
 *
 * Deterministic and total: same inputs always yield the same token.
 */
export function classifyExecutionFailure({ success, errorCategory = null, validationPassed = null } = {}) {
  // Only a failed execution (success strictly false) has something to diagnose — a
  // success, or an unknown/absent success flag, has no failure to explain.
  if (success !== false) return null;

  // 1. A mapped raw error category is the most specific signal.
  const mapped = RAW_CATEGORY_TAXONOMY.get(normalizeToken(errorCategory));
  if (mapped) return mapped;

  // 2. No recognized error, but the run missed its declared validation criterion —
  //    a regression the error sweep didn't produce a category for.
  if (validationPassed === false) return 'testing';

  return UNKNOWN_EXECUTION_FAILURE;
}

/**
 * Tally execution-failure categories across every FAILED-execution record. A
 * successful execution has nothing to explain, and a record that was never handed
 * off (executionOutcome null) never executed — neither is counted.
 *
 * Returns `{ entries, unknown, unclassified, diagnosed, total }` — the same shape,
 * and the same three-bucket discipline, as summarizeRejectionReasons:
 *   - `entries`      — `[{ category, count }]` of REAL diagnoses only, commonest first.
 *   - `unknown`      — classified `unknown-failure`: we looked, no signal explained
 *                      it. A MEASURED gap.
 *   - `unclassified` — a failed execution with no valid category stored at all:
 *                      recorded before this field existed, or by a path that passed
 *                      no failure signal. An UNMEASURED gap — a different fact from
 *                      `unknown`, with a different remedy.
 *   - `diagnosed`    — records carrying a real diagnosis (sum of `entries`).
 *   - `total`        — every failed-execution record: the population being diagnosed.
 *                      `total === 0` means, and only means, "no hand-off has failed".
 *
 * `unknown`/`unclassified` stay OUT of `entries` so they can't crowd real diagnoses
 * out of a caller's top-N list — they measure missing data, they are not findings.
 */
// The shared tally + render engine, bound to the execution-failure taxonomy. The
// counting rules, commonest-first sort, taxonomy-order tie-break, three-bucket
// discipline, and top-N-line render live in `lib/taxonomyTally.js` (#2800); this
// module supplies only the population predicate, the stored-token accessor, the
// vocabulary/sentinel, the gloss, and the gap wording.
const executionFailureTally = createTaxonomyTally({
  predicate: (o) => o.executionOutcome === 'failure',
  select: (o) => o.failureCategory,
  field: 'category',
  vocabulary: EXECUTION_FAILURE_CATEGORIES,
  sentinel: UNKNOWN_EXECUTION_FAILURE,
  glossFn: formatExecutionFailure,
  gapWording: {
    // "2 of 3 failed with no recognized cause" is a real, actionable fact about LI's
    // own blind spot, and the honest line when it's all we have.
    unknown: (n, total) => `${n} of ${total} failed with no recognized cause`,
    unclassified: (n, total) => `${n} of ${total} not yet classified`
  }
});

/**
 * Tally execution-failure categories across every FAILED-execution record. A
 * successful execution has nothing to explain, and a record that was never handed
 * off (executionOutcome null) never executed — neither is counted.
 *
 * Returns `{ entries, unknown, unclassified, diagnosed, total }` — the same shape,
 * and the same three-bucket discipline, as summarizeRejectionReasons:
 *   - `entries`      — `[{ category, count }]` of REAL diagnoses only, commonest first.
 *   - `unknown`      — classified `unknown-failure`: we looked, no signal explained
 *                      it. A MEASURED gap.
 *   - `unclassified` — a failed execution with no valid category stored at all:
 *                      recorded before this field existed, or by a path that passed
 *                      no failure signal. An UNMEASURED gap — a different fact from
 *                      `unknown`, with a different remedy.
 *   - `diagnosed`    — records carrying a real diagnosis (sum of `entries`).
 *   - `total`        — every failed-execution record: the population being diagnosed.
 *                      `total === 0` means, and only means, "no hand-off has failed".
 *
 * `unknown`/`unclassified` stay OUT of `entries` so they can't crowd real diagnoses
 * out of a caller's top-N list — they measure missing data, they are not findings.
 */
export function summarizeExecutionFailures(outcomes = []) {
  return executionFailureTally.summarize(outcomes);
}

/**
 * Render a tally as one prompt line: the commonest `limit` diagnoses, glossed,
 * followed by whichever gaps are non-zero.
 *
 * Returns '' ONLY when no hand-off has failed, so a caller may safely read '' as
 * "there is nothing to explain". It must never fall silent merely because the
 * failures are undiagnosed: a report that says "0% executed" and then stays quiet
 * about why is exactly the blindness this taxonomy exists to remove.
 */
export function formatExecutionFailures(outcomes = [], limit = 3) {
  return executionFailureTally.format(outcomes, limit);
}
