/**
 * Object utilities.
 *
 * `isPlainObject(v)` — `true` when `v` is a non-null, non-array `object`. The
 * project standard for "is this a `{...}`-shaped value?" — used to gate JSON
 * sanitizers, deep-merge recursion, and LLM-response shape guards. Note that
 * `Date`, `Map`, class instances, etc. also return `true` (matches every
 * inline call-site this helper replaces, which all run against `JSON.parse`
 * output or LLM payloads that never carry exotic prototypes).
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

export const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Prototype-pollution guard: skip keys that would mutate Object.prototype
// when assigned through normal property access. Every current call site
// gates input through a Zod schema (which strips unknown keys), but the
// helper is shared across three routes and a future caller could hand it
// `req.body` directly or an LLM tool-call payload — defense in depth is
// cheap. Reflects no behavioral change for valid input.
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const deepMerge = (base, patch) => {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...(isPlainObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (POLLUTING_KEYS.has(k)) continue;
    out[k] = isPlainObject(base?.[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
};
