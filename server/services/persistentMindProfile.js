/**
 * Resolve the persistent mind's pinned text-reasoning profile.
 *
 * This deliberately has no fallback path. A mind waking on a different
 * provider/model than the one the user selected is a different identity, not
 * a recovery. It also does not start a model, fetch a catalog, or generate
 * text: it only reads the already-configured provider and status services.
 */

import { effortLevelsForProvider } from '../lib/providerModels.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { getProviderById } from './providers.js';
import { getProviderStatus, isProviderAvailable } from './providerStatus.js';

const providerModelIds = (provider) => (provider?.models || [])
  .map((model) => typeof model === 'string' ? model : model?.id)
  .filter(Boolean);

/**
 * Resolve a configured profile to one exact provider route, or a visible
 * failure suitable for the supervisor's degraded state.
 */
export async function resolvePersistentMindProfile(rawProfile) {
  const profile = normalizePersistentMindProfile(rawProfile);
  if (!profile.enabled) return { ok: false, error: 'Persistent mind profile is disabled' };
  if (!profile.providerId || !profile.model) {
    return { ok: false, error: 'Persistent mind profile requires a provider and model' };
  }

  const provider = await getProviderById(profile.providerId);
  if (!provider || provider.enabled === false) {
    return { ok: false, error: `Pinned provider "${profile.providerId}" is unavailable` };
  }
  if (!isProviderAvailable(provider.id)) {
    const status = getProviderStatus(provider.id);
    return { ok: false, error: status?.message || `Pinned provider "${provider.id}" is unavailable` };
  }

  const models = providerModelIds(provider);
  if (models.length > 0 && !models.includes(profile.model)) {
    return { ok: false, error: `Pinned model "${profile.model}" is not available from provider "${provider.id}"` };
  }
  const supportedEfforts = effortLevelsForProvider(provider, profile.model);
  if (profile.effort && (!supportedEfforts || !supportedEfforts.includes(profile.effort))) {
    return { ok: false, error: `Pinned effort "${profile.effort}" is not supported by provider "${provider.id}"` };
  }

  return {
    ok: true,
    provider,
    model: profile.model,
    effort: profile.effort || null,
    thinkingInterface: profile.thinkingInterface,
  };
}
