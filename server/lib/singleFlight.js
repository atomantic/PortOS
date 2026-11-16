/**
 * `createSingleFlight()` → `run(key, fn)` — keyed in-flight coalescer: concurrent calls for the same
 * key share one `fn()` execution and result.
 *
 * The slot auto-clears on settle. `createSingleFlight({ exclusive: true })` also keeps different
 * keys from overlapping: a different key waits for the in-flight call, then joins or starts its own
 * (used where the work must never run twice at once, such as starting a local runtime). Minimal by
 * design (no TTL/result cache layered on top, doesn't reject concurrent callers). Used by
 * `services/promptRunner.js`'s fallback mark-and-pick, `lib/managedDaemon.js`'s on-demand wake, and
 * `services/ollamaManager.js`'s starts.
 */

/**
 * Keyed single-flight coalescer. `run(key, fn)` returns the in-flight promise for `key` if one exists; otherwise it invokes `fn()`, stores the promise, and auto-clears the slot once it settles (resolve OR reject), so concurrent callers share one execution and a new call after the clear starts fresh.
 * Minimal by design: no TTL / result cache (`aiToolkit/providers.js` keeps its own TTL-cache-then-coalesce since the vendored toolkit may not import PortOS lib modules, AGENTS.md) and no rejection of concurrent callers (`sseDownload.js` deliberately uses the opposite "reject-if-busy" idiom: a second client can't share one client's SSE stream and it holds a kill handle, not a shareable promise).
 * Cleanup is a two-arm `then(clear, clear)`, not `.finally`: a `.finally` re-raises a rejection on a derived promise nothing awaits (unhandledRejection), while the two-arm form clears on both paths and swallows the cleanup branch's copy; each caller's own `await run(...)` still sees the original reject.
 * `exclusive: true` keeps different keys from overlapping: a call whose key differs from the in-flight one waits for it to settle, then joins or starts its own (e.g. starting one daemon, where the key only says whether the result is shareable; `ollamaManager.startServer` keys on its launch env).
 *
 * @param {{ exclusive?: boolean }} [options]
 * @returns {{ run: <T>(key: any, fn: () => Promise<T>) => Promise<T> }}
 */
export function createSingleFlight({ exclusive = false } = {}) {
  const inFlight = new Map(); // key -> shared in-flight promise

  function run(key, fn) {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const work = fn();
    inFlight.set(key, work);
    // Identity-guarded delete: `run` never overwrites a live slot, but guarding on identity keeps a late settle from clobbering a fresh entry under the same key.
    const clear = () => { if (inFlight.get(key) === work) inFlight.delete(key); };
    work.then(clear, clear);
    return work;
  }

    async function runExclusive(key, fn) {
    while (inFlight.size) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      await Promise.allSettled([...inFlight.values()]);
    }
    return run(key, fn);
  }

  return { run: exclusive ? runExclusive : run };
}
