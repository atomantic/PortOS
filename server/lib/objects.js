/**
 * Object utilities: `isPlainObject`, `deepMerge`, `isEmptyScalar`, `POLLUTING_KEYS`, canonical JSON and prefix-fitting helpers.
 *
 * Object utilities. `isPlainObject(v)`: the project standard for "is this a `{...}`-shaped value?" (non-null, non-array `object`), gating JSON sanitizers, deep-merge recursion and LLM-response shape guards; `Date`, `Map` and class instances
 * also return `true` (matching every call site it replaced, which runs on `JSON.parse` output or LLM payloads).
 * `deepMerge` is the shared deep-merge (promoted from `services/voice/config.js` after being reinvented in `services/meatspace/meatspacePost.js` and `routes/loras.js#POST /auth/civitai`). Semantics: both base[k] and patch[k] plain objects → recurse;
 * arrays are REPLACED as leaf values; primitives, null and any non-plain-object patch[k] overwrite verbatim; a non-plain-object patch is returned directly unless `undefined` (then `base` unchanged, so an optional patch keeps defaults);
 * a null/undefined/non-object `base` is an empty object (`deepMerge(undefined, { a: 1 })` → `{ a: 1 }`). Does NOT mutate `base`.
 */

export const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** `isEmptyScalar(v)`: true for null, undefined, a whitespace-only string or an empty array. Gates one-way gap-fill in merge helpers: overwrite a survivor's field only when its value is "empty" AND the loser's is not. */
export const isEmptyScalar = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
  || (Array.isArray(v) && v.length === 0);

// Prototype-pollution guard: skip keys that would mutate Object.prototype through normal property access. Call sites gate input through Zod (which strips unknown keys), but the helper is shared and a future caller could hand it
// `req.body` or an LLM tool-call payload. Exported so other sanitizers (e.g. server/services/settings.js stripStoreKeys) share one denylist.
export const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Get-or-create a bucket in a map keyed by an externally supplied string (request body, upload, peer payload, model output). Returns null for POLLUTING_KEYS so the caller skips the record (a bare `map[key] ||= …` would return
// Object.prototype for `__proto__` and bump a counter on every object); `hasOwn` keeps inherited names such as `toString` from reading as an existing bucket.
export const bucketFor = (map, key, init) => {
  if (POLLUTING_KEYS.has(key)) return null;
  if (!Object.hasOwn(map, key)) map[key] = init();
  return map[key];
};

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
 * Stable, canonical JSON serialization: recursively sorts object keys so structurally-equal values give byte-identical strings regardless of insertion order; for strings (or hashes) that must be COMPARABLE ACROSS MACHINES (e.g. a sidecar's
 * gen-params hash re-derived on a receiver where the object was rebuilt in another key order). Arrays preserve order; only TRUE plain objects (prototype `Object.prototype` or `null`) are key-sorted; everything else (primitives, null,
 * Date / Map / class instances) serializes via native `JSON.stringify` (a Date round-trips via `toJSON`, not `{}`); `undefined` and functions drop as `JSON.stringify` does.
 */
// NB: isPlainObject() is intentionally loose (true for Date/Map/class instances) and WRONG here (it would key-sort a Date's empty own keys into `{}`); require the prototype to be Object.prototype or null.
const isCanonicalSortable = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

export const canonicalStringify = (value) => {
  if (Array.isArray(value)) {
    // Array.from (not .map) so SPARSE-array holes serialize as `null` like JSON.stringify ([1,,2] → "[1,null,2]"); `.map` keeps holes and `.join` would emit invalid JSON, diverging the cross-machine hash.
    return `[${Array.from(value, (v) => canonicalStringify(v) ?? 'null').join(',')}]`;
  }
  if (isCanonicalSortable(value)) {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = canonicalStringify(value[key]);
      // Skip keys whose value serializes to undefined (functions / undefined), as JSON.stringify drops them.
      if (serialized === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * The longest prefix of `items` whose JSON encoding fits `maxChars`, the shape every prompt-catalog builder needs. `wrap` measures the envelope the items are embedded in, not the bare array. Measured on the growing prefix, not estimated per item
 * (an item's cost depends on separators and escaping; an under-counting budget is a truncated payload the model reads as complete).
 */
export const boundedByJsonChars = (items, maxChars, wrap = (kept) => kept) => {
  const kept = [];
  for (const item of Array.isArray(items) ? items : []) {
    kept.push(item);
    if (JSON.stringify(wrap(kept)).length > maxChars) {
      kept.pop();
      break;
    }
  }
  return kept;
};
