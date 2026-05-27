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

/**
 * `isEmptyScalar(v)` — `true` when `v` is null, undefined, a whitespace-only
 * string, or an empty array. Used to gate one-way gap-fill logic in merge
 * helpers: only overwrite a field on the survivor when the survivor's value is
 * "empty" by this definition AND the loser's value is not.
 */
export const isEmptyScalar = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
  || (Array.isArray(v) && v.length === 0);

// Prototype-pollution guard: skip keys that would mutate Object.prototype
// when assigned through normal property access. Every current call site
// gates input through a Zod schema (which strips unknown keys), but the
// helper is shared across three routes and a future caller could hand it
// `req.body` directly or an LLM tool-call payload — defense in depth is
// cheap. Reflects no behavioral change for valid input.
//
// Exported so other sanitizers (e.g. server/services/settings.js
// stripStoreKeys) can share one canonical denylist instead of redefining
// it (drift risk on security-relevant constants).
export const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const deepMerge = (base, patch) => {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...(isPlainObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (POLLUTING_KEYS.has(k)) continue;
    out[k] = isPlainObject(base?.[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
};

/**
 * Stable, canonical JSON serialization: recursively sorts object keys so two
 * structurally-equal values produce byte-identical strings regardless of the
 * key-insertion order they happened to be built with. Use this when a string
 * (or hash of a string) must be COMPARABLE ACROSS MACHINES — e.g. content-
 * hashing a sidecar's gen-params on a sender and re-deriving the same hash on
 * a receiver where the object was rebuilt in a different key order.
 *
 * Arrays preserve order (order is semantic for arrays); object keys are sorted
 * lexicographically. Only TRUE plain objects (prototype `Object.prototype` or
 * `null`) get key-sorted; everything else — primitives, null, and exotic
 * objects like Date / Map / class instances — serializes via native
 * `JSON.stringify` rules (so e.g. a Date round-trips through `toJSON` to its
 * ISO string instead of collapsing to `{}`). `undefined` and functions are
 * dropped exactly as `JSON.stringify` drops them.
 */
// NB: isPlainObject() is intentionally loose (true for Date/Map/class
// instances), so it's WRONG here — it would key-sort a Date's (empty) own keys
// into `{}`. Require the prototype to be Object.prototype or null instead.
const isCanonicalSortable = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

export const canonicalStringify = (value) => {
  if (Array.isArray(value)) {
    // Array.from (not .map) so SPARSE-array holes are visited and serialized as
    // `null` — matching JSON.stringify ([1,,2] → "[1,null,2]"). `.map` preserves
    // holes, and `.join` would then emit invalid JSON ("[1,,2]"), diverging the
    // cross-machine hash for any value containing a sparse array.
    return `[${Array.from(value, (v) => canonicalStringify(v) ?? 'null').join(',')}]`;
  }
  if (isCanonicalSortable(value)) {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = canonicalStringify(value[key]);
      // Skip keys whose value serializes to undefined (functions / undefined)
      // — matches JSON.stringify dropping them from objects.
      if (serialized === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
};
