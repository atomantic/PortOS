/**
 * Keyed single-flight coalescer.
 *
 * `run(key, fn)` returns the in-flight promise already registered for `key`
 * if one exists; otherwise it invokes `fn()`, stores the resulting promise
 * under `key`, and auto-clears the slot once that promise settles (resolve
 * OR reject). Concurrent callers for the same key therefore share one `fn()`
 * execution and one result, and a genuinely-new call after the slot clears
 * starts fresh work.
 *
 * Minimal by design — it coalesces keyed work and nothing more. Two other
 * in-flight-coalescing sites deliberately do NOT use this helper:
 * - It does NOT layer a TTL / result cache on top. `aiToolkit/providers.js`
 *   keeps its own self-contained TTL-cache-then-coalesce logic — the vendored
 *   toolkit must not import PortOS-side lib modules (CLAUDE.md), so it can't
 *   build on this even if it wanted the bare coalesce.
 * - It does NOT reject concurrent callers. `sseDownload.js` deliberately uses
 *   the opposite "reject-if-busy" idiom (a second client can't share one
 *   client's SSE event stream, and it holds a kill handle rather than a
 *   shareable promise), so it is intentionally NOT built on this helper.
 *
 * Cleanup uses a two-arm `then(clear, clear)` rather than `.finally`: a
 * `.finally` on the stored promise re-raises a rejection on a derived promise
 * that nothing awaits → unhandledRejection. The two-arm `then` clears the slot
 * on both settle paths and swallows the cleanup branch's copy of the rejection,
 * while each caller's own `await run(...)` still observes the original reject.
 *
 * @returns {{ run: <T>(key: any, fn: () => Promise<T>) => Promise<T> }}
 */
export function createSingleFlight() {
  const inFlight = new Map(); // key -> shared in-flight promise

  function run(key, fn) {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const work = fn();
    inFlight.set(key, work);
    // Identity-guarded delete: `run` never overwrites a live slot, so the
    // entry can only be the promise we set — but guarding on identity keeps
    // a late settle from clobbering a fresh entry under the same key.
    const clear = () => { if (inFlight.get(key) === work) inFlight.delete(key); };
    work.then(clear, clear);
    return work;
  }

  return { run };
}
