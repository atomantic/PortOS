/**
 * The shared TTL cache in front of `probeOpenAiModels`: `probeOpenAiModelsCached(endpoint, apiKey)` and `resetOpenAiModelsProbeCache()`.
 *
 * 15s TTL, keyed `endpoint\napiKey` (two providers on one authenticated endpoint must not inherit each other's 401) and storing the PROMISE so N providers sharing a daemon share one socket. It lives BELOW its two readers, the Providers page's readiness checklist
 * (`services/providerReadiness.js`) and the pre-dispatch context gate (`services/observedContextWindows.js`), so a page poll and a run starting together cost one listing and can't disagree about a daemon that restarted between them; each clears it through the same reset
 * (`services/providerReadiness.js#resetProviderReadinessCache` for the llama-server lifecycle routes). An unexpected throw drops the entry rather than poisoning it for the TTL; expired entries are swept on every miss.
 * `GET /v1/models` is a listing, never an LLM call, so it is safe from a settings-page poll and the dispatch path under the no-cold-bootstrap policy in AGENTS.md.
 */

import { probeOpenAiModels } from './openAiModelsProbe.js';

/** Loopback daemons answer or refuse in single-digit ms, so a short bound keeps a page poll snappy; a host slower than this at a model listing won't serve an agent run either, and "unreachable" points at the right fix. */
const PROBE_TIMEOUT_MS = 2_000;

/** Just under the Providers page's 20s poll so each poll gets a fresh answer (a just-started daemon shows on the next tick) while a reload atop a poll reuses it; within ONE request the promise cache collapses providers sharing an endpoint. */
const PROBE_TTL_MS = 15_000;

// endpoint + key → { at, promise }: the PROMISE, so N providers sharing an endpoint in one batch share a socket instead of all missing a not-yet-written entry. The key is in the cache key because two providers can share an authenticated endpoint with different credentials (one getting the other's 401 would be a false "not running").
const probeCache = new Map();

/**
 * TTL-cached `GET {endpoint}/models`.
 *
 * @returns {Promise<{reachable:boolean, models:string[]|null, contextWindows:Record<string,number>|null, error:string|null}>} `models: null` means reachable but unreadable; distinct from `[]` (up, nothing loaded).
 */
export function probeOpenAiModelsCached(endpoint, apiKey = '') {
  const now = Date.now();
  const cacheKey = `${endpoint}\n${apiKey}`;
  const cached = probeCache.get(cacheKey);
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.promise;
  // Sweep while here: an edited or deleted provider would otherwise leave its old endpoint behind forever.
  for (const [key, entry] of probeCache) {
    if (now - entry.at >= PROBE_TTL_MS) probeCache.delete(key);
  }
  // Written BEFORE the await so concurrent callers join this probe; a rejected probe would poison the entry for its TTL, so drop it on failure (`probeOpenAiModels` resolves for expected failures, so this is the unexpected-throw path).
  const promise = probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS, apiKey }).catch((err) => {
    probeCache.delete(cacheKey);
    throw err;
  });
  probeCache.set(cacheKey, { at: now, promise });
  return promise;
}

/** Drop every cached listing so the next read reflects a daemon just started, stopped or relaunched at another context size (the transitions the llama-server lifecycle routes announce via `resetProviderReadinessCache()`). */
export function resetOpenAiModelsProbeCache() {
  probeCache.clear();
}
