/**
 * The shared TTL cache in front of `probeOpenAiModels`.
 *
 * Two independent readers ask the same local daemons the same question: the
 * Providers page's readiness checklist (`services/providerReadiness.js`) and the
 * pre-dispatch context gate (`services/observedContextWindows.js`). Giving each
 * its own cache would double the polling on every endpoint and let the two
 * disagree about a daemon that restarted between them, so the cache lives HERE —
 * beside the probe, below both services — and each clears it through the same
 * reset.
 *
 * `GET /v1/models` is a listing, never an LLM call, so this is safe to ask from
 * a settings-page poll and from the dispatch path alike under the
 * no-cold-bootstrap policy in AGENTS.md.
 */

import { probeOpenAiModels } from './openAiModelsProbe.js';

/**
 * Loopback daemons answer (or refuse the connection) in single-digit
 * milliseconds, so a short bound keeps a page poll snappy. A host that needs
 * longer than this to answer a model listing is not going to serve an agent run
 * either, and reporting it as unreachable points at the right fix.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Sized just under the Providers page's 20s poll so consecutive polls each get
 * a fresh answer (a daemon the user just started must show up on the next tick,
 * not two ticks later) while a reload landing on top of a poll still reuses it.
 * Within ONE request the promise cache below is what collapses providers that
 * share an endpoint.
 */
const PROBE_TTL_MS = 15_000;

// endpoint + key → { at, promise } — the PROMISE, not the settled value, so N
// providers sharing one endpoint in the same batch share one socket instead of
// all missing a not-yet-written cache entry at once. The key is part of the
// cache key because two providers can point at one authenticated endpoint with
// different credentials, and one of them getting the other's 401 would be a
// false "not running".
const probeCache = new Map();

/**
 * TTL-cached `GET {endpoint}/models`.
 *
 * @returns {Promise<{reachable:boolean, models:string[]|null, contextWindows:Record<string,number>|null, error:string|null}>}
 *   `models: null` means reachable but the listing could not be read — distinct
 *   from `[]`, a server that is up with nothing loaded.
 */
export function probeOpenAiModelsCached(endpoint, apiKey = '') {
  const now = Date.now();
  const cacheKey = `${endpoint}\n${apiKey}`;
  const cached = probeCache.get(cacheKey);
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.promise;
  // Sweep while we are here: entries are keyed by endpoint, and an edited or
  // deleted provider would otherwise leave its old endpoint behind forever.
  for (const [key, entry] of probeCache) {
    if (now - entry.at >= PROBE_TTL_MS) probeCache.delete(key);
  }
  // Written BEFORE the await so concurrent callers join this probe. A rejected
  // probe would poison the entry for its TTL, so drop it on failure —
  // `probeOpenAiModels` resolves for every expected failure, making this the
  // unexpected-throw path only.
  const promise = probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS, apiKey }).catch((err) => {
    probeCache.delete(cacheKey);
    throw err;
  });
  probeCache.set(cacheKey, { at: now, promise });
  return promise;
}

/**
 * Drop every cached listing, so the next read reflects a daemon that was just
 * started, stopped, or relaunched at a different context size — the transitions
 * the llama-server lifecycle routes already announce through
 * `resetProviderReadinessCache()`.
 */
export function resetOpenAiModelsProbeCache() {
  probeCache.clear();
}
