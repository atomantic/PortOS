/**
 * The one owner of the persisted metadata-value rules — `isTruthyMeta(v)` (`true`/`'true'` = set), `isFalsyMeta(v)` (`false`/`'false'` = cleared) and `sameMetaValue(a, b)`.
 *
 * Task metadata keeps its JSON types since #16407, but rows stored before it, and
 * tasks from peers on older versions, hold every top-level scalar as a string with
 * nulls dropped. Readers accept both forms: a bare `if (metadata.x)` is a bug
 * (`'false'` is truthy), and so is `metadata.x === true`. Pure leaf; import
 * directly, never inject.
 */

/**
 * Persisted task-metadata boolean flags: `true`/`'true'` when set,
 * `false`/`'false'` when cleared, anything else unset.
 */
export const isTruthyMeta = (value) => value === true || value === 'true';
export const isFalsyMeta = (value) => value === false || value === 'false';

const isScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value);

/**
 * Do two metadata values mean the same thing across the stored forms? A scalar
 * equals its string (`true` and `'true'`, `3` and `'3'`), `null` equals absent,
 * and objects/arrays compare by content.
 */
export function sameMetaValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (isScalar(a) && isScalar(b)) return String(a) === String(b);
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
