/**
 * Keyed stale-while-revalidate cache for readings that are EXPENSIVE to take and
 * SLOW to change — provider quota panels, scraped usage, anything behind a
 * multi-second CLI/PTY spawn.
 *
 * The problem it solves: a plain TTL cache blocks the first caller after the TTL
 * lapses. When producing a value costs 10-20 seconds, that caller is a page load
 * rendering nothing, and the number it waited for had moved by single digits. So
 * a stale reading is served IMMEDIATELY and the refresh lands behind the
 * response. Values carry their own `fetchedAt`, so serving stale never makes the
 * reported age dishonest — it only stops that age being paid for synchronously.
 *
 * Three things a naive serve-stale loop gets wrong, handled here once:
 *
 * 1. **A background refresh must not reject unhandled.** The stored promise
 *    always resolves to `{ value }` or `{ error }`. A caller served stale never
 *    awaits it, and an unawaited rejection takes the process down.
 * 2. **A failure keeps the last good value** rather than flipping a healthy card
 *    to an error state on one transient hiccup — and records `failedAt`, so a
 *    persistently broken producer is retried on a backoff instead of respawned
 *    by every caller. Without that, "serve stale and revalidate" degrades into
 *    "spawn a subprocess per request" exactly when the subprocess is broken.
 * 3. **Waiting is terminal.** A cold cache can answer `PENDING` for callers that
 *    render "still reading" and poll — but a cold cache whose producer has
 *    already FAILED throws instead, because `PENDING` there promises a reading
 *    that is never coming and the poller never stops.
 *
 * `wait` is a three-state enum rather than a pair of booleans on purpose: the
 * combination "give me a live reading, but also don't wait for one" has no
 * meaning, and encoding it as two flags forces a precedence rule at every layer
 * that threads them.
 *
 * @see server/lib/singleFlight.js — the bare in-flight coalescer, with no cache.
 */

/** A cold cache whose first reading is still being produced. */
export const PENDING = Symbol('stale-while-revalidate:pending');

/**
 * What a reader is willing to wait for:
 * - `fresh`  — bypass the cache and block for a live reading (an explicit
 *              Refresh, or work that is about to spend real money on the result).
 * - `cached` — serve whatever is cached, revalidating behind the caller; block
 *              only when nothing is cached at all. The default.
 * - `never`  — as `cached`, but a cold cache returns `PENDING` instead of
 *              blocking.
 */
export const WAIT = Object.freeze({ FRESH: 'fresh', CACHED: 'cached', NEVER: 'never' });

/**
 * @param {object} options
 * @param {number} options.ttlMs                 How long a reading counts as fresh.
 * @param {number} [options.failureBackoffMs]    Minimum gap between attempts after a
 *   failure. Paces a broken producer without making a healthy one wait.
 * @param {(value:any)=>boolean} [options.isComplete] Whether a SUCCESSFUL reading
 *   earns a full TTL. A producer can succeed and still return something degraded
 *   (a `/usage` panel that rendered without its limit lines); those are cached
 *   for `partialTtlMs` so the next view self-heals — but still CACHED, because
 *   not caching them at all turns every poll into a fresh subprocess spawn.
 * @param {() => void} [options.onSettled] Synchronous notification after success/failure is cached.
 * @param {number} [options.partialTtlMs]        TTL for a reading `isComplete` rejects.
 */
export function createStaleWhileRevalidate({
  ttlMs,
  failureBackoffMs = 30 * 1000,
  isComplete = () => true,
  partialTtlMs = 30 * 1000,
  onSettled,
} = {}) {
  const entries = new Map(); // key -> { at, value, ttl, failedAt, inflight }

  /**
   * Start one production and fold concurrent callers into it. The returned
   * promise NEVER rejects (see the docblock) — callers wanting the error unwrap
   * `{ error }` themselves.
   */
  function start(key, produce) {
    const inflight = Promise.resolve()
      .then(produce)
      .then((value) => {
        entries.set(key, { at: Date.now(), value, ttl: isComplete(value) ? ttlMs : partialTtlMs });
        return { value };
      })
      .catch((error) => {
        // Keep the last good reading and record WHEN this failed, so the backoff
        // can pace the retry. Dropping the entry here is what would let every
        // subsequent poll start a fresh spawn.
        const { at, value, ttl } = entries.get(key) || {};
        entries.set(key, { at, value, ttl, failedAt: Date.now() });
        return { error };
      })
      .then(result => {
        // A notification failure must not turn a good reading into a failed
        // production or reject an unobserved background refresh.
        try {
          onSettled?.();
        } catch (error) {
          console.error(`❌ Cache settlement notification failed: ${error.message}`);
        }
        return result;
      });
    entries.set(key, { ...entries.get(key), inflight });
    return inflight;
  }

  /**
   * @param {any} key
   * @param {() => Promise<any>} produce
   * @param {{ wait?: 'fresh'|'cached'|'never' }} [options]
   * @returns {Promise<any|PENDING>} the reading, or `PENDING` on a cold cache
   *   under `wait: 'never'`. Throws when production failed with nothing cached
   *   to fall back on.
   */
  async function read(key, produce, { wait = WAIT.CACHED } = {}) {
    const live = wait === WAIT.FRESH;
    const hit = entries.get(key);
    const cached = hit?.value !== undefined;
    if (!live && cached && Date.now() - hit.at < (hit.ttl ?? ttlMs)) return hit.value;

    // Don't hammer a producer that just failed — unless the caller explicitly
    // asked for a live reading, which is a user waiting on a button.
    if (!live && hit?.failedAt !== undefined && Date.now() - hit.failedAt < failureBackoffMs) {
      if (cached) return hit.value; // stale, but real
      // Nothing cached and the producer is failing. `PENDING` here would promise
      // a reading that is not coming, and the caller would poll forever — so
      // fail, and let it render an error instead.
      throw new Error('the previous attempt failed; backing off before retrying');
    }

    const inflight = hit?.inflight || start(key, produce);
    if (!live) {
      if (cached) return hit.value; // stale-while-revalidate
      if (wait === WAIT.NEVER) return PENDING;
    }
    const settled = await inflight;
    if (settled.error) throw settled.error;
    return settled.value;
  }

  /** Test seam / explicit invalidation. Omit `key` to clear everything. */
  function clear(key) {
    if (key === undefined) entries.clear();
    else entries.delete(key);
  }

  return { read, clear };
}
