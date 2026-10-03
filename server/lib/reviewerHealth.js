/**
 * Bounded reviewer-failure vocabulary. Keep this leaf independent of provider
 * configuration: health readers must not load a runner or probe a provider.
 */
export const REVIEWER_CONFIG_FAULT_CODES = Object.freeze([
  'NO_MODEL', 'REVIEWER_UNAVAILABLE', 'REVIEWER_UNSUPPORTED', 'REVIEWER_ACCESS_DENIED',
]);

export const isReviewerConfigFault = code => REVIEWER_CONFIG_FAULT_CODES.includes(code);

/**
 * Classify only an explicit OpenCode access refusal, never a generic 403 or a
 * transport failure. The caller projects these fields from structured CLI
 * output; response bodies, headers and paths are not health evidence.
 */
export function reviewerAccessFailureCode(reviewer, failure) {
  if (reviewer !== 'opencode' || !failure || typeof failure !== 'object') return null;
  const freeTierError = failure.name === 'FreeTierError';
  const accessDenied = failure.name === 'APIError'
    && failure.statusCode === 403
    && failure.isRetryable === false
    && (failure.providerErrorType === 'FreeTierError'
      || failure.message === "OpenCode's free tier can only be used from within OpenCode");
  return freeTierError || accessDenied ? 'REVIEWER_ACCESS_DENIED' : null;
}

/** First nonempty tier with ALL members unpaused, or the first configured tier.
 * Empty drafts never participate. Shared by runtime and the settings preview;
 * configuration faults are warnings, not quota pauses or a new fallback rule.
 */
export function activeReviewerGroupIndex(groups, health = {}, now = Date.now()) {
  const first = groups.findIndex(group => group.length > 0);
  const healthy = groups.findIndex(group => group.length > 0
    && group.every(reviewer => !(Number(health[reviewer]?.pausedUntil) > now)));
  return healthy < 0 ? first : healthy;
}

// Diagnostic values are a closed vocabulary, never provider prose or paths.
export const MALFORMED_REVIEW_REASONS = Object.freeze([
  'invalid_json', 'oversized_content', 'invalid_envelope',
  'incomplete_finding', 'verdict_findings_mismatch', 'unknown',
]);
export const REVIEW_FINISH_REASONS = Object.freeze([
  'stop', 'length', 'content_filter', 'tool_calls', 'error', 'unknown',
]);
// Saturate one character beyond the verdict limit; never retain unbounded size.
export const MAX_REVIEW_RESPONSE_LENGTH = 20001;

export function normalizeReviewFinishReason(value) {
  return REVIEW_FINISH_REASONS.includes(value) ? value : 'unknown';
}

/** Project only bounded scalar evidence, including explicit unknown metrics. */
export function reviewFailureDiagnostics(value) {
  const length = value?.responseLengthChars;
  const knownLength = Number.isSafeInteger(length) && length >= 0;
  return {
    reason: MALFORMED_REVIEW_REASONS.includes(value?.reason) ? value.reason : 'unknown',
    finishReason: normalizeReviewFinishReason(value?.finishReason),
    responseLengthChars: knownLength ? Math.min(length, MAX_REVIEW_RESPONSE_LENGTH) : null,
    responseLengthCapped: knownLength ? length > MAX_REVIEW_RESPONSE_LENGTH || value?.responseLengthCapped === true : null,
  };
}
