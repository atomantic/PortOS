/**
 * `createConcurrencyGate(limit)` → `run(fn)` — cap on simultaneous async work for ONE module-scoped
 * budget, released FIFO.
 *
 * Sibling to `mapWithConcurrency.js`, which caps in-flight work *within one array map*; a gate is
 * shared state, so several call sites fanning out at the same remote respect one budget instead of
 * each respecting its own while the host sees the sum. `createMutex` (`asyncMutex.js`) is this with
 * `limit` fixed at 1 — prefer it for mutual exclusion. Note the budget is per-MODULE, not per-host:
 * two modules calling one host each get their own gate. Used by `huggingFaceMetadata.js` (4) and
 * `ollamaRegistryCatalog.js` (16), whose cold catalog-enrichment bursts otherwise arrive at a free
 * public API as a thundering herd — which the Hub answers with an HTTP/2 GOAWAY that surfaces as a
 * bare `fetch failed`.
 */

/**
 * Process-wide bounded-concurrency gate for un-batched async work.
 *
 * `createConcurrencyGate(limit)` → `run(fn)`, which resolves/rejects with
 * `fn()`'s result once a slot frees. Waiters are released FIFO. `fn` runs at
 * most `limit`-at-a-time; a rejecting `fn` still releases its slot.
 *
 * Sibling to two narrower primitives, and the reason to reach for this one
 * instead:
 * - `mapWithConcurrency.js` caps in-flight work *within one array map*. That is
 *   not enough when several independent call sites fan out at the same remote
 *   at once — each map stays under its own cap while the host sees the sum. A
 *   gate is shared state, so one budget holds across call sites and requests.
 * - `asyncMutex.js` (`createMutex`) is this with `limit` fixed at 1. Prefer it
 *   when the intent is mutual exclusion rather than a throughput cap.
 *
 * @param {number} limit - max simultaneous `fn()` executions (floored at 1)
 * @returns {{ run: <T>(fn: () => Promise<T>) => Promise<T>, active: () => number }}
 */
export function createConcurrencyGate(limit) {
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 1;
  const waiting = []; // FIFO of `resolve` callbacks holding a slot request
  let active = 0;

  function release() {
    // Hand the slot straight to the oldest waiter, or give it back if none.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  async function run(fn) {
    if (active < max) active += 1;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run, active: () => active };
}
