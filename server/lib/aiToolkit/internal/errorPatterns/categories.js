/** Define error categories, terminal run predicates, and the truncated-line boundary. */

export const ERROR_CATEGORIES = {
  CANCELED: 'canceled',
  RATE_LIMIT: 'rate-limit',
  USAGE_LIMIT: 'usage-limit',
  AUTH_ERROR: 'auth-error',
  SPAWN_ERROR: 'spawn-error',
  MODEL_NOT_FOUND: 'model-not-found',
  IMAGE_UNSUPPORTED: 'image-unsupported',
  NETWORK_ERROR: 'network-error',
  TIMEOUT: 'timeout',
  // An explicitly shortened caller spending cap, not provider health.
  RUNTIME_BUDGET_EXHAUSTED: 'runtime-budget-exhausted',
  OUTPUT_LIMIT: 'output-limit',
  QUOTA_EXCEEDED: 'quota-exceeded',
  // A model safety refusal is terminal for this request. Never retry it or
  // switch providers; it says nothing about provider health.
  CONTENT_REFUSAL: 'content-refusal',
  // A LOCAL inference runtime ran out of accelerator memory mid-request (Metal
  // on Apple silicon, CUDA elsewhere). Distinct from QUOTA_EXCEEDED (money) and
  // from TIMEOUT (the request never finished): the request was ACCEPTED and then
  // killed by the device allocator, so the same prompt can succeed once the GPU
  // drains. See LOCAL_RUNTIME_OOM_PATTERN.
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  UNKNOWN: 'unknown'
};

/**
 * Was this rejection an intentional stop rather than a failed AI attempt?
 *
 * A canceled terminal — a Stop of the in-flight run, a coordinator cancelling
 * its own active LLM call, or a host shutdown tree-killing the child — is
 * finalized with `canceled: true` on the run metadata, and the prompt runner
 * stamps `code: 'RUN_CANCELED'` onto the rejection it raises from it.
 *
 * Every caller that CLASSIFIES a failure — picks a pause kind, files a gap /
 * investigation task, benches a provider, marks a run `error` — must ask this
 * FIRST. A cancellation is evidence about the operator, not about the provider
 * or the automation: treating it as a defect files spurious follow-up work and
 * spends a post-mortem diagnosing a human pressing Stop. Lives here (rather
 * than beside the code that stamps it) so the classifying callers can ask
 * without importing the whole provider/runner graph.
 *
 * @param {*} err — a rejection from an LLM call
 * @returns {boolean}
 */
export const isRunCanceledError = (err) => (
  !!err && (err.code === 'RUN_CANCELED' || err.canceled === true)
);

/** Structured only: old generic absolute timeouts retain provider recovery. */
export const isRuntimeBudgetError = (err) => (
  err?.code === 'RUN_RUNTIME_BUDGET_EXHAUSTED'
  || err?.errorAnalysis?.category === ERROR_CATEGORIES.RUNTIME_BUDGET_EXHAUSTED
);

// A non-printing, non-line-terminator byte prefixed to a buffer whose index 0 is
// a slice boundary rather than a witnessed line start, so a `^…/m` pattern
// cannot match there. Full rationale on resolveSignalOrigin.
export const UNTRUSTED_BOUNDARY = '\x00';
