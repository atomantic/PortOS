/**
 * What a local daemon is CURRENTLY serving, window included — observed from
 * `GET /v1/models`, never persisted.
 *
 * A provider seeded by migration (`opencode-vllm` and friends) stores no
 * `contextWindow` and no `modelContextWindows`, so every context-budget
 * question about it answered "unknown" and every prompt was dispatched
 * regardless of size. On one install that cost ten consecutive 600s timeouts:
 * the endpoint accepted a prompt larger than its window, emitted its banner,
 * and produced 36 bytes in ten minutes (#7441). The daemon knew the answer the
 * whole time — vLLM reports `max_model_len` on the same listing row
 * `providerReadiness.js` already polls.
 *
 * Two rules make this OBSERVED RUNTIME STATE rather than configuration:
 *
 *   1. Nothing here writes `providers.json`. The window is a property of the
 *      process that is running right now — relaunch llama-server at a smaller
 *      `-c` and the stored number would be a lie — and a user editing the
 *      provider must never find a probe's value sitting in their record.
 *   2. An endpoint that is down, unreadable, or silent about its windows
 *      contributes NOTHING. `null`/`{}` flows through as "unknown", which every
 *      consumer already treats as "no constraint", so an install whose daemon
 *      is off routes exactly as it did before this module existed.
 *
 * No LLM call is involved — a model listing is free — so this is safe to ask on
 * the dispatch path under the no-cold-bootstrap policy in AGENTS.md. The listing
 * itself is TTL-cached in `lib/openAiModelsProbeCache.js`, shared with the
 * Providers page's readiness poll.
 */

import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { bareLocalModelId } from '../lib/providerModels.js';
import { probeOpenAiModelsCached } from '../lib/openAiModelsProbeCache.js';

/**
 * The windows this provider's daemon is serving right now, keyed by every
 * spelling the provider could dispatch under, or `null` when there is nothing
 * observed.
 *
 * Both spellings are emitted on purpose: the listing keys by the daemon's bare
 * id, while `resolveEffectiveModel` hands downstream code whatever the provider
 * record says — which for an OpenCode wrapper is the `<kind>/`-prefixed form. A
 * map keyed on only one of the two resolves for half the providers and silently
 * answers "unknown" for the rest.
 *
 * @param {object} provider — a RAW provider record (endpoint + envVars intact)
 * @param {{probe?: Function}} [deps]
 * @returns {Promise<Record<string, number>|null>}
 */
export async function observedContextWindows(provider, deps = {}) {
  const runtime = localRuntimeForProvider(provider);
  // Not daemon-backed: a cloud endpoint is somebody else's install to probe,
  // and its catalog windows already arrive through model refresh.
  if (!runtime) return null;

  const probe = deps.probe || probeOpenAiModelsCached;
  const result = await probe(runtime.endpoint, provider?.apiKey || '').catch(() => null);
  // The probe already rejects anything that is not a positive integer, so what
  // arrives is either usable or absent.
  const served = result?.contextWindows;
  if (!served || Object.keys(served).length === 0) return null;

  const windows = { ...served };
  // Alias each provider-listed spelling onto the window its bare form resolves.
  const offered = [provider?.defaultModel, ...(Array.isArray(provider?.models) ? provider.models : [])];
  for (const model of offered) {
    if (typeof model !== 'string' || windows[model]) continue;
    const bare = bareLocalModelId(model, runtime.kind);
    if (bare && windows[bare]) windows[model] = windows[bare];
  }
  return windows;
}

/**
 * `provider` with its daemon's live windows folded into `modelContextWindows`,
 * for a caller about to ask a context question about it.
 *
 * Returns the SAME object when there is nothing observed, so the no-daemon and
 * daemon-down paths allocate nothing and compare identically. The copy is
 * in-memory only — see this module's header for why it is never persisted.
 *
 * Observation WINS over a stored catalog entry for the same id: the stored
 * number is whatever a refresh recorded whenever the user last pressed it,
 * while the probe describes the process that will serve this very request. An
 * explicit `provider.contextWindow` still outranks both, because
 * `knownContextWindow` prefers it — a number the user typed is a deliberate
 * override, not a stale guess.
 *
 * @param {object} provider
 * @param {{probe?: Function}} [deps]
 * @returns {Promise<object>}
 */
export async function withObservedContextWindows(provider, deps = {}) {
  const observed = await observedContextWindows(provider, deps);
  if (!observed) return provider;
  return { ...provider, modelContextWindows: { ...provider?.modelContextWindows, ...observed } };
}
