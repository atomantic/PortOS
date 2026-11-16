/**
 * `createConcurrencyGate(limit)` → `run(fn)` — cap on simultaneous async work for ONE module-scoped
 * budget, released FIFO.
 *
 * Unlike `mapWithConcurrency.js` (caps within one array map), a gate is shared state, so
 * several call sites fanning out at one remote respect one budget. `createMutex`
 * (`asyncMutex.js`) is this with `limit` 1; prefer it for mutual exclusion. The budget is
 * per-MODULE, not per-host.
 */

/**
 * `run(fn)` resolves/rejects with `fn()`'s result once a slot frees; waiters
 * release FIFO and a rejecting `fn` still releases its slot.
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
