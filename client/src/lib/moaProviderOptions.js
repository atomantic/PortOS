/**
 * Turn saved Mixture of Agents presets into the virtual `moa:<id>` provider records a provider picker can offer.
 *
 * Mirrors the server's `lib/moaConfig.js#moaProviderRecord`: the record's model
 * is the aggregator's (its pinned model, else that provider's default), since
 * the preset pins every member and the aggregator is the acting, billed run.
 * An unreadable preset or one whose aggregator has no model is left out: it
 * cannot be pinned to a route. Disabled presets stay offered, because they
 * still run (the aggregator alone).
 */

export function moaProviderOptions(moaPresets, providers = []) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return (Array.isArray(moaPresets) ? moaPresets : []).flatMap((preset) => {
    if (preset.invalid || !preset.providerId) return [];
    const model = preset.aggregator?.model || byId.get(preset.aggregator?.providerId)?.defaultModel || null;
    if (!model) return [];
    return [{
      id: preset.providerId,
      name: `MoA: ${preset.name}`,
      type: 'moa',
      enabled: true,
      models: [model],
      defaultModel: model,
      moaPresetId: preset.id,
    }];
  });
}
