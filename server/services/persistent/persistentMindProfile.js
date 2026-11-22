/**
 * Resolve the persistent mind's pinned text-reasoning route.
 *
 * This deliberately has no fallback path. A mind waking on a different
 * provider/model than the one the user selected would violate their inference
 * choice. Identity and memory remain independent of that selection. It also does not start a model, fetch a catalog, or generate
 * text: it only reads the already-configured provider and status services.
 *
 * Two routes resolve through the same exact-or-refuse check: the home profile
 * every ordinary message and scheduled wake uses, and a saved thinking preset
 * that one explicitly selected message borrows for a single turn.
 */

import { effortLevelsForProvider } from '../../lib/provider/providerModels.js';
import { normalizePersistentMindProfile, persistentMindToolFreeRefusal } from '../../lib/persistent/persistentMindProfile.js';
import {
  findPersistentMindThinkingPreset,
  normalizePersistentMindThinkingSelection,
  samePersistentMindThinkingSelection,
} from '../../lib/persistent/persistentMindThinkingPresets.js';
import { getProviderById } from '../provider/providers.js';
import { getProviderStatus, isProviderAvailable } from '../provider/providerStatus.js';
import { isMoaProviderId } from '../../lib/provider/providerTypes.js';

const providerModelIds = (provider) => (provider?.models || [])
  .map((model) => typeof model === 'string' ? model : model?.id)
  .filter(Boolean);

/**
 * An MoA preset route (`moa:<id>`, #17386). The preset pins every member, so
 * the route's model must name the aggregator's model and no effort may be
 * pinned. An advisor that cannot run is dropped at run time; an aggregator
 * that cannot run refuses the route now, since the turn could not be written.
 */
async function resolveMoaRoute({ providerId, model, effort, noun }) {
  const { getMoaPreset, moaPresetRefusals, resolveMoaProvider } = await import('../moaPresets.js');
  const provider = await resolveMoaProvider(providerId).catch(() => null);
  if (!provider) return { ok: false, error: `${noun} provider "${providerId}" is unavailable` };
  const aggregatorRefusal = (await moaPresetRefusals(await getMoaPreset(provider.moaPresetId)))
    .find((refusal) => refusal.role === 'aggregator');
  if (aggregatorRefusal) return { ok: false, error: `${noun} aggregator ${aggregatorRefusal.refusal}` };
  if (model !== provider.defaultModel) {
    return { ok: false, error: `${noun} model "${model}" is not the aggregator model of MoA preset "${provider.moaPresetId}"` };
  }
  if (effort) return { ok: false, error: `${noun} effort "${effort}" is not supported by an MoA preset` };
  return { ok: true, provider, model, effort: null };
}

/**
 * Validate one exact provider/model/effort selection against the live registry.
 * Every failure is a refusal: nothing here may substitute a nearby route.
 */
async function resolveExactRoute({ providerId, model, effort, noun, incompleteError, requireCatalog = false }) {
  if (!providerId || !model) return { ok: false, error: incompleteError };
  if (isMoaProviderId(providerId)) return resolveMoaRoute({ providerId, model, effort, noun });

  const provider = await getProviderById(providerId);
  if (!provider || provider.enabled === false) {
    return { ok: false, error: `${noun} provider "${providerId}" is unavailable` };
  }
  if (!isProviderAvailable(provider.id)) {
    const status = getProviderStatus(provider.id);
    return { ok: false, error: status?.message || `${noun} provider "${provider.id}" is unavailable` };
  }

  const toolFreeRefusal = persistentMindToolFreeRefusal(provider);
  if (toolFreeRefusal) return { ok: false, error: toolFreeRefusal };

  const models = providerModelIds(provider);
  if (requireCatalog && models.length === 0) {
    return { ok: false, error: `${noun} cannot verify model "${model}": provider "${provider.id}" has no available model catalog` };
  }
  if ((requireCatalog || models.length > 0) && !models.includes(model)) {
    return { ok: false, error: `${noun} model "${model}" is not available from provider "${provider.id}"` };
  }
  const supportedEfforts = effortLevelsForProvider(provider, model);
  if (effort && (!supportedEfforts || !supportedEfforts.includes(effort))) {
    return { ok: false, error: `${noun} effort "${effort}" is not supported by provider "${provider.id}"` };
  }

  return { ok: true, provider, model, effort: effort || null };
}

/**
 * Resolve a configured profile to one exact provider route, or a visible
 * failure suitable for the supervisor's degraded state.
 */
export async function resolvePersistentMindProfile(rawProfile) {
  const profile = normalizePersistentMindProfile(rawProfile);
  if (!profile.enabled) return { ok: false, error: 'Persistent mind profile is disabled' };
  const route = await resolveExactRoute({
    providerId: profile.providerId,
    model: profile.model,
    effort: profile.effort,
    noun: 'Pinned',
    incompleteError: 'Persistent mind profile requires a provider and model',
  });
  if (!route.ok) return route;
  return { ...route, temporary: false, presetId: null, presetLabel: null, thinkingInterface: profile.thinkingInterface };
}

/**
 * Resolve one message's temporary thinking session.
 *
 * The home profile still gates admission: a temporary session borrows a model,
 * never authority. A removed preset, a retired model, or an effort the provider
 * dropped is a refusal — the turn must not quietly answer on the default route
 * the user was deliberately stepping away from.
 */
export async function resolvePersistentMindThinkingSession({ presetId, selection, config } = {}) {
  const profile = normalizePersistentMindProfile(config?.persistentMindProfile);
  if (!profile.enabled) return { ok: false, error: 'Persistent mind profile is disabled' };
  const preset = findPersistentMindThinkingPreset(config?.persistentMindThinkingPresets, presetId);
  if (!preset) {
    return { ok: false, requiresResubmission: true, error: `Temporary thinking preset "${presetId}" is no longer available` };
  }
  const accepted = normalizePersistentMindThinkingSelection(selection);
  if (!accepted || accepted.id !== presetId) {
    return { ok: false, requiresResubmission: true, error: 'Temporary thinking session has no valid accepted route; send a new message to authorize it' };
  }
  if (!samePersistentMindThinkingSelection(accepted, preset)) {
    return { ok: false, requiresResubmission: true, error: 'Temporary thinking preset changed after acceptance; send a new message to authorize its new route' };
  }
  const route = await resolveExactRoute({
    providerId: accepted.providerId,
    model: accepted.model,
    effort: accepted.effort,
    requireCatalog: true,
    noun: `Temporary thinking preset "${preset.label}"`,
    // Unreachable: normalization drops a preset without both, so this is the
    // belt-and-braces refusal rather than a route the resolver could invent.
    incompleteError: `Temporary thinking preset "${preset.label}" requires a provider and model`,
  });
  if (!route.ok) return route;
  return {
    ...route,
    temporary: true,
    presetId: preset.id,
    presetLabel: accepted.label || preset.label,
    thinkingInterface: profile.thinkingInterface,
  };
}
