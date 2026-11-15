/**
 * The one owner of the persisted metadata-boolean rule — `isTruthyMeta(v)` (`true`/`'true'` = set) and
 * `isFalsyMeta(v)` (`false`/`'false'` = cleared)
 *
 * ; anything else is unset. TASKS.md round-trips flags as strings, so a bare `if (metadata.x)` is a
 * bug. Pure leaf; import directly, never inject.
 */

/**
 * Persisted task-metadata boolean flags.
 *
 * Contract: a metadata boolean is `true`/`'true'` when set and `false`/`'false'`
 * when cleared (TASKS.md round-trips values as strings); anything else is unset.
 * A bare `if (metadata.x)` is a bug for exactly that reason — `'false'` is truthy.
 */
export const isTruthyMeta = (value) => value === true || value === 'true';
export const isFalsyMeta = (value) => value === false || value === 'false';
