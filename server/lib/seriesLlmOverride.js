// `resolveSeriesLlmOverride(series, overrides)` returns the provider and model a Pipeline LLM action should use, falling back to the series LLM.
//
// `resolveSeriesLlmOverride(series, { overrideProvider, overrideModel })` → `{ provider, model, providerMatchesSeries }`: the provider and model a Pipeline LLM action should use, falling back to the series' configured LLM when the client passes no override, so every action (extract-canon, extract-scenes, season-episodes-generate) honors the series header's pick instead of the global active provider.
// The never-cross-providers rule lives in `llmRoutePin.js` (a model id belongs to the provider it was picked for), so the series model is inherited only while the EFFECTIVE provider is still the series provider. This is the series-shaped adapter over it: `series.llm` spells the pin `{ provider, model }` and callers want `undefined` (not `null`) for an unresolved field so it passes straight through to the extractor.

import { resolveLlmRoutePin } from './llmRoutePin.js';

/**
 * Resolve the effective LLM provider/model for a Pipeline action against a series.
 *
 * @param {{ llm?: { provider?: string, model?: string } } | null | undefined} series
 * @param {{ overrideProvider?: string, overrideModel?: string }} [overrides]
 * @returns {{ provider: string|undefined, model: string|undefined, providerMatchesSeries: boolean }}
 */
export function resolveSeriesLlmOverride(series, { overrideProvider, overrideModel } = {}) {
  const { providerId, model, providerMatchesPin } = resolveLlmRoutePin(
    { providerId: series?.llm?.provider, model: series?.llm?.model },
    { providerId: overrideProvider, model: overrideModel },
  );
  return {
    provider: providerId ?? undefined,
    model: model ?? undefined,
    providerMatchesSeries: providerMatchesPin,
  };
}
