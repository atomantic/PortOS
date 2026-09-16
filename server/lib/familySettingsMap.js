import { isPlainObject } from './objects.js';

/**
 * The merge rule shared by every per-provider-family map stored in
 * `data/settings.json` — today the plan prices (`subscriptionCosts`) and the
 * plan tiers (`subscriptionPlanTiers`).
 *
 * Both stores hold `{ [familyId]: value }` and both owe their editors the same
 * ABSENT-vs-PRESENT-BUT-EMPTY contract AGENTS.md calls load-bearing: a family
 * the patch omits keeps its stored value, while one sent as an empty value is
 * an intentional CLEAR and is deleted. An editor that submits only the rows it
 * changed depends on the first half; a user cancelling a plan depends on the
 * second. Written twice, a fix to one would silently miss the other, so the
 * loop lives here once and each store supplies only its value normalizer.
 *
 * Pure: the settings I/O stays in the services that own each key.
 */

/**
 * Normalize a whole stored map, dropping every entry the value normalizer
 * clears. `normalizeValue` returns `null` for "no value" — that is what makes a
 * cleared entry disappear rather than persist as 0 / "".
 */
export function normalizeFamilyMap(raw, normalizeValue) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [family, value] of Object.entries(raw)) {
    const normalized = normalizeValue(value);
    if (normalized !== null) out[family] = normalized;
  }
  return out;
}

/** Apply a patch to a stored map: omitted keeps, cleared deletes. */
export function mergeFamilyMap(stored, patch, normalizeValue) {
  const merged = normalizeFamilyMap(stored, normalizeValue);
  const incoming = isPlainObject(patch) ? patch : {};
  for (const [family, value] of Object.entries(incoming)) {
    const normalized = normalizeValue(value);
    if (normalized === null) delete merged[family];
    else merged[family] = normalized;
  }
  return merged;
}
