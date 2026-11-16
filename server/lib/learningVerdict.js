/**
 * Learning verdict sentinels: `validationPassed` is true/false (criterion declared, met/missed), null (none declared), or `SKIP_LEARNING_VERDICT` (run was never evaluated and must not be recorded).
 */

// A JSON-safe string, not a Symbol: it is persisted on the agent record, and older readers narrow with `typeof v === 'boolean'`, degrading it to null.
export const SKIP_LEARNING_VERDICT = 'skip-learning';

// Strict equality: an unrecognized sentinel from a newer peer is not a skip and keeps the recorded exit-code fallback.
export function isSkipLearningVerdict(verdict) {
  return verdict === SKIP_LEARNING_VERDICT;
}

// Anything that is not an explicit boolean (absent, malformed, skip sentinel) becomes null, so "not evaluated" never reads as "declared and missed".
export function toValidationVerdict(verdict) {
  return typeof verdict === 'boolean' ? verdict : null;
}
