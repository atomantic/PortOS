/**
 * What a local daemon is CURRENTLY serving, window included: observed from
 * `GET /v1/models`, never persisted (#7441). A down or silent endpoint yields
 * `null`/`{}` = "unknown", i.e. no constraint. No LLM call; the listing is
 * TTL-cached in `lib/openAiModelsProbeCache.js`.
 */

import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { aliasServedContextWindows, mergeObservedContextWindows } from '../lib/providerContextWindows.js';
import { probeOpenAiModelsCached } from '../lib/openAiModelsProbeCache.js';

// Windows the provider's daemon serves now (null when none), keyed by both the
// daemon's bare id and the `<kind>/`-prefixed form `resolveEffectiveModel` yields.
// `provider` must be a RAW record (endpoint + envVars intact).
export async function observedContextWindows(provider, deps = {}) {
  const runtime = localRuntimeForProvider(provider);
  // Cloud endpoints are not ours to probe; their windows arrive via model refresh.
  if (!runtime) return null;

  const probe = deps.probe || probeOpenAiModelsCached;
  const result = await probe(runtime.endpoint, provider?.apiKey || '').catch(() => null);
  return aliasServedContextWindows(provider, runtime, result?.contextWindows);
}

// `provider` with its daemon's live windows merged into `modelContextWindows`
// (same object when nothing is observed; in-memory only). Ranking lives in
// `lib/providerContextWindows.js`, shared with the provider card.
export async function withObservedContextWindows(provider, deps = {}) {
  return mergeObservedContextWindows(provider, await observedContextWindows(provider, deps));
}
