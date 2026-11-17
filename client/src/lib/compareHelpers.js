// `equalByKeys(a, b, keys)` / `equalListByKeys(a, b, keys)`: typed key-based equality for `useAutoRefetch`'s `compare` option (skip the re-render when nothing the widget renders changed).
//
// The typed alternative to `sameJsonShape` (JSON.stringify equality) when only a known subset of fields drives the render, so a monotonic mtime/timestamp nudge or an unrendered field can't break dedup.
// A key is a string property name (`'status'`), a dotted path (`'context.running'`, read with optional chaining so a missing intermediate reads as undefined), or a function `(item) => value` for derived comparisons (e.g. `(d) => d?.count ?? 1`).

const valueAt = (obj, key) => {
  if (typeof key === 'function') return key(obj);
  if (key.includes('.')) return key.split('.').reduce((acc, part) => acc?.[part], obj);
  return obj?.[key];
};

// True when `a` and `b` are equal (`===`) on every key. Null/undefined-safe:
// a missing object reads each key as undefined, mirroring `a?.key`.
export const equalByKeys = (a, b, keys) =>
  keys.every((key) => valueAt(a, key) === valueAt(b, key));

// True when `a` and `b` are arrays of equal length whose items are pairwise equal on every key. A non-array input falls back to reference identity, so two distinct non-array values (`{}` vs `{}`) read as changed and are never silently deduped.
export const equalListByKeys = (a, b, keys) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  return a.every((item, i) => equalByKeys(item, b[i], keys));
};
