// Key-based equality helpers for `useAutoRefetch`'s `compare` option — the
// "skip the re-render when nothing the widget renders changed" pattern. These
// are the typed alternative to `sameJsonShape` (JSON.stringify equality):
// reach for these when only a known subset of fields drives the render, so a
// monotonic mtime/timestamp nudge or an unrendered field can't break dedup.
//
// A "key" is one of:
//   - a string property name (`'status'`);
//   - a dotted path (`'context.running'`) — each segment is read with optional
//     chaining, so a missing intermediate object reads as undefined;
//   - a function `(item) => value` for derived comparisons (e.g. a normalized
//     `(d) => d?.count ?? 1`, or a helper like `getLastProgressDate`).

const valueAt = (obj, key) => {
  if (typeof key === 'function') return key(obj);
  if (key.includes('.')) return key.split('.').reduce((acc, part) => acc?.[part], obj);
  return obj?.[key];
};

// True when `a` and `b` are equal (`===`) on every key. Null/undefined-safe:
// a missing object reads each key as undefined, mirroring `a?.key`.
export const equalByKeys = (a, b, keys) =>
  keys.every((key) => valueAt(a, key) === valueAt(b, key));

// True when `a` and `b` are arrays of equal length whose items are pairwise
// equal on every key. When either input is not an array, falls back to
// reference identity (`a === b`) — so two distinct non-array values (e.g.
// `{}` vs `{}`) read as changed and are never silently deduped; only `null`
// vs `null` / the same reference vs itself read as equal.
export const equalListByKeys = (a, b, keys) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  return a.every((item, i) => equalByKeys(item, b[i], keys));
};
