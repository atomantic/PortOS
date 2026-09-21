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
