// Shared resolution for "which provider/model should a Pipeline LLM action
// use?" — falls back to the series' configured LLM when the client doesn't
// pass an explicit override, so every Pipeline action (extract-canon,
// extract-scenes, season-episodes-generate) honors the provider/model picked
// in the series header instead of the global active provider.
//
// A model id is provider-specific, so the series model is only inherited when
// the EFFECTIVE provider is still the series provider. An override that
// switches providers without naming a model leaves the model blank, so the new
// provider's default resolves rather than forwarding a foreign model id that
// would fail.
//
// Returns `undefined` (not `''`) for an unresolved provider/model so callers
// can pass the result straight through to the extractor without re-mapping.

/**
 * Resolve the effective LLM provider/model for a Pipeline action against a series.
 *
 * @param {{ llm?: { provider?: string, model?: string } } | null | undefined} series
 * @param {{ overrideProvider?: string, overrideModel?: string }} [overrides]
 * @returns {{ provider: string|undefined, model: string|undefined, providerMatchesSeries: boolean }}
 */
export function resolveSeriesLlmOverride(series, { overrideProvider, overrideModel } = {}) {
  const seriesProvider = series?.llm?.provider || '';
  const provider = overrideProvider || seriesProvider || undefined;
  // No override means we're using the series provider, so the series model is
  // always safe to inherit; an override matches only when it names the same
  // provider the series model belongs to.
  const providerMatchesSeries = !overrideProvider || overrideProvider === seriesProvider;
  const model = overrideModel || (providerMatchesSeries ? series?.llm?.model : undefined) || undefined;
  return { provider, model, providerMatchesSeries };
}
