/**
 *  Shared persisted execution-duration key contract for the server and browser.
 */

// Effort sentinel for a provider with no effort control: a no-effort run is its own
// bucket, never a key ending in a bare separator.
export const EXECUTION_EFFORT_NONE = 'default';

export const EXECUTION_KEY_SEPARATOR = '|';

// A key part must be a non-empty string without the separator, else `a|p|m|x` is both
// "model m at effort x" and "model m|x at no effort".
export const nonEmptyKeyPart = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes(EXECUTION_KEY_SEPARATOR) ? trimmed : null;
};

/** The `taskType|providerId|model` prefix; null when any part is missing (a partial key would merge unlike runs). */
export function executionKeyPrefix({ taskType, providerId, model } = {}) {
  const parts = [nonEmptyKeyPart(taskType), nonEmptyKeyPart(providerId), nonEmptyKeyPart(model)];
  if (parts.some((part) => part === null)) return null;
  return parts.join(EXECUTION_KEY_SEPARATOR);
}

/**
 * The full `byTaskTypeExecution` key for one run; null when task type, provider or model
 * is missing so the recorder skips the write. A blank effort becomes
 * `EXECUTION_EFFORT_NONE`. The ONE place writer and reader compose this key.
 */
export function executionDurationKey({ taskType, providerId, model, effort } = {}) {
  const prefix = executionKeyPrefix({ taskType, providerId, model });
  if (prefix === null) return null;
  return `${prefix}${EXECUTION_KEY_SEPARATOR}${nonEmptyKeyPart(effort) ?? EXECUTION_EFFORT_NONE}`;
}

/**
 * The identity prefix of a stored key (parse counterpart of `executionKeyPrefix`); null
 * for a malformed key (e.g. hand-edited learning.json), which the reader drops.
 */
export function executionKeyPrefixOf(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(EXECUTION_KEY_SEPARATOR);
  return parts.length === 4 ? parts.slice(0, 3).join(EXECUTION_KEY_SEPARATOR) : null;
}

// Execution-scoped estimates require more evidence than the broader task-type bucket.
export const MIN_EXECUTION_SAMPLES = 3;
