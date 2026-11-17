/**
 * Telegram outbound rate limiter (pure, no I/O or timers).
 *
 * `createTokenBucket({ max = 30, refillMs = 60_000 })` → `{ consume() }`, the coarse full-refill-per-window bucket both transports (`services/telegram.js`, `services/telegramBridge.js`) use against Telegram's ~30 msg/min bot throttle. Each transport creates its OWN instance: they are never both active, and one shared bucket would let a transport inherit the other's drained budget. Reads `Date.now()`, owns no timer.
 */

const DEFAULT_MAX = 30;
const DEFAULT_REFILL_MS = 60_000;

/**
 *
 * @param {{ max?: number, refillMs?: number }} [opts]
 * @returns {{ consume: () => boolean }} `consume()` takes a token, returning
 *   false when the bucket is empty for the current window.
 */
export function createTokenBucket({ max = DEFAULT_MAX, refillMs = DEFAULT_REFILL_MS } = {}) {
  let tokens = max;
  let lastRefill = Date.now();

  return {
    consume() {
      const now = Date.now();
      if (now - lastRefill >= refillMs) {
        tokens = max;
        lastRefill = now;
      }
      if (tokens <= 0) return false;
      tokens--;
      return true;
    }
  };
}
