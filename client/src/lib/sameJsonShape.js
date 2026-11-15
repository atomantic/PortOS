// `sameJsonShape(prev, next)` — JSON.stringify-based equality for `useAutoRefetch`'s `compare` option
// on small, deterministically-shaped poll payloads.
//
// Stringified-shape equality for `useAutoRefetch`'s `compare` option and other
// "skip the re-render when nothing changed" callers. JSON.stringify is the
// right tool when:
//   - the payload is small (poll snapshots, not large lists),
//   - the source is a server route that returns deterministic key order, and
//   - values are JSON-safe primitives + plain objects + arrays.
// For monotonic keys like `updatedAt`/`status` prefer a typed comparator —
// this is the fallback when no single key captures equality.
export const sameJsonShape = (prev, next) =>
  JSON.stringify(prev) === JSON.stringify(next);
