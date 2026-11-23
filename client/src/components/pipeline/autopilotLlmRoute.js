import { assignmentModelOptions, resolveCliEffort } from '../../utils/providers';

/**
 * Resolve one Autopilot LLM route that inherits from a base route: the run
 * default, the judge route (inheriting the run default) and a per-stage route
 * (inheriting the run default or judge) all follow this one rule, so the three
 * selectors cannot drift apart.
 *
 * - provider: the override, else the base provider.
 * - model: the override, else the base model, but only while the provider is
 *   still the base's (a model id belongs to its provider; switching providers
 *   with no model pick means "that provider's default", i.e. '').
 * - effort: the override, else the base effort, clamped to what the resolved
 *   provider/model actually offers (what the server will really run).
 */
export function resolveInheritedLlmRoute(providers, {
  baseProviderId = '',
  baseModel = '',
  baseEffort = '',
  overrideProvider = '',
  overrideModel = '',
  overrideEffort = '',
} = {}) {
  const providerId = overrideProvider || baseProviderId;
  const model = overrideModel
    || ((!overrideProvider || overrideProvider === baseProviderId) ? baseModel : '');
  const provider = providers.find((p) => p.id === providerId);
  return {
    providerId,
    model,
    provider,
    models: assignmentModelOptions(null, providers, providerId),
    effort: resolveCliEffort(overrideEffort || baseEffort, provider, model),
  };
}
