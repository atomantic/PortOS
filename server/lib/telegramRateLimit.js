/**
 * Telegram outbound rate limiter (pure — no I/O, no timers).
 *
 * Telegram throttles bots at roughly 30 messages/minute. Both transports
 * (`services/telegram.js`, `services/telegramBridge.js`) enforce that with the
 * same coarse token bucket: a full refill once the window has elapsed since the
 * last refill, rather than a continuous drip.
 *
 * Each transport creates its OWN instance. They are never both active, and a
 * single module-level bucket shared between them would be a behaviour change —
 * switching transports would inherit the other one's drained budget.
 */

const DEFAULT_MAX = 30;
const DEFAULT_REFILL_MS = 60_000;

/**
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
