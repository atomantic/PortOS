/**
 * `normalizeFamilyMap` and `mergeFamilyMap`: the shared merge rule for per-provider-family settings maps.
 *
 * Plan prices and tiers distinguish absent from empty: an omitted family keeps
 * its stored value, one sent empty is an intentional clear and is deleted. Each store supplies only
 * its value normalizer. Pure.
 */

import { isPlainObject } from './objects.js';

/** Normalize a whole stored map; `normalizeValue` returns `null` for "no value", so a cleared entry disappears. */
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
