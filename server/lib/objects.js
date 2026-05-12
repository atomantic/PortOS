/**
 * Object utilities.
 *
 * `deepMerge` is the project's shared deep-merge — promoted from
 * `services/voice/config.js` after the same pattern was reinvented in
 * `services/meatspacePost.js` and `routes/loras.js#POST /auth/civitai`.
 *
 * Semantics (matches the original voice/config.js implementation):
 *   - Both base[k] and patch[k] are plain objects → recurse.
 *   - Arrays are REPLACED, not merged (Object.entries iterates patch's keys
 *     so the entire array under each key is replaced; this matches every
 *     existing call site's expectation that arrays are leaf values).
 *   - Primitives, null, and any non-plain-object value at patch[k] overwrite
 *     base[k] verbatim.
 *   - When patch itself is not a plain object, returns patch directly
 *     (preserving the "patch is the new value" intent), unless patch is
 *     undefined — then returns base unchanged so callers can pass an
 *     optional patch without losing the defaults.
 *   - When `base` is null/undefined/non-object, it's treated as an empty
 *     object — `deepMerge(undefined, { a: 1 })` returns `{ a: 1 }`. This
 *     matches the function's own `base?.[k]` recursion guard, which already
 *     assumes a missing base is fine.
 *
 * Does NOT mutate `base`.
 */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const deepMerge = (base, patch) => {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...(isPlainObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(base?.[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
};
