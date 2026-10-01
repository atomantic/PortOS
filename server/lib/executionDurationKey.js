/** Shared persisted execution-duration key contract for the server and browser. */

// Effort sentinel for a provider with no effort control. The repo's absent-vs-empty
// rule: a run at no effort level must be its own bucket, never a key ending in a
// bare separator that an `''` and an `undefined` would both produce.
export const EXECUTION_EFFORT_NONE = 'default';

export const EXECUTION_KEY_SEPARATOR = '|';

// A key part must be a non-empty string that cannot itself contain the separator:
// otherwise `a|p|m|x` is both "model m at effort x" and "model m|x at no effort",
// and the provider+model rollup would sum two unrelated identities together.
export const nonEmptyKeyPart = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes(EXECUTION_KEY_SEPARATOR) ? trimmed : null;
};

/**
 * Compose the `taskType|providerId|model` prefix shared by every effort level of
 * one execution identity. Returns null when any part is missing — a partial key
 * would silently merge unlike runs. Pure.
 */
export function executionKeyPrefix({ taskType, providerId, model } = {}) {
  const parts = [nonEmptyKeyPart(taskType), nonEmptyKeyPart(providerId), nonEmptyKeyPart(model)];
  if (parts.some((part) => part === null)) return null;
  return parts.join(EXECUTION_KEY_SEPARATOR);
}

/**
 * Compose the full `byTaskTypeExecution` key for one run. Returns null when the
 * task type, provider or model is missing, so the recorder can skip the write
 * instead of banking a run under a key that means nothing. A missing/blank
 * effort becomes the explicit `EXECUTION_EFFORT_NONE` sentinel. Pure — the ONE
 * place writer and reader compose this key, so they cannot drift.
 */
export function executionDurationKey({ taskType, providerId, model, effort } = {}) {
  const prefix = executionKeyPrefix({ taskType, providerId, model });
  if (prefix === null) return null;
  return `${prefix}${EXECUTION_KEY_SEPARATOR}${nonEmptyKeyPart(effort) ?? EXECUTION_EFFORT_NONE}`;
}

/**
 * The `taskType|providerId|model` identity a stored execution key belongs to — the
 * parse counterpart of `executionKeyPrefix`, so composition and decomposition live
 * and change together. Null for anything that is not a well-formed key (a
 * hand-edited learning.json), which the reader drops rather than mis-grouping. Pure.
 */
export function executionKeyPrefixOf(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(EXECUTION_KEY_SEPARATOR);
  return parts.length === 4 ? parts.slice(0, 3).join(EXECUTION_KEY_SEPARATOR) : null;
}

// Execution-scoped estimates require more evidence than the broader task-type bucket.
export const MIN_EXECUTION_SAMPLES = 3;
