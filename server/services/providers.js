/**
 * Compatibility shim for PortOS services that import from providers.js
 * Re-exports toolkit provider service functions
 */

import { setAIToolkitInstance, requireToolkit } from '../lib/aiToolkitState.js';

// `server/index.js` imports `setAIToolkit` from here — keep the named export
// stable while the underlying singleton lives in `lib/aiToolkitState.js` so
// providers / runner / promptService all observe the same instance.
export const setAIToolkit = setAIToolkitInstance;

// Pure classification helpers, not toolkit-instance methods — direct
// re-exports (no requireToolkit() indirection needed) so callers can classify
// a provider shape without an initialized toolkit instance.
// `canRefreshModels` is the model-refresh capability predicate the providers
// routes decorate their payloads with; it is derived on read and never stored.
// `ollamaRefreshGroupKey` buckets providers whose refresh hits the same Ollama
// daemon with the same probe, so a fan-out can fetch once per daemon instead of
// once per provider. `refreshProviderModelsBatch` below already applies it —
// this export is for a caller that needs to reason about the grouping without
// running a refresh.
export {
  isOllamaBackedProvider,
  canRefreshModels,
  ollamaRefreshGroupKey,
} from '../lib/aiToolkit/providers.js';

export async function getAllProviders() {
  return requireToolkit().services.providers.getAllProviders();
}

export async function getProviderById(id) {
  return requireToolkit().services.providers.getProviderById(id);
}

export async function getActiveProvider() {
  return requireToolkit().services.providers.getActiveProvider();
}

export async function setActiveProvider(id) {
  return requireToolkit().services.providers.setActiveProvider(id);
}

export async function createProvider(data) {
  return requireToolkit().services.providers.createProvider(data);
}

export async function updateProvider(id, data) {
  return requireToolkit().services.providers.updateProvider(id, data);
}

export async function deleteProvider(id) {
  return requireToolkit().services.providers.deleteProvider(id);
}

export async function testProvider(id) {
  return requireToolkit().services.providers.testProvider(id);
}

export async function refreshProviderModels(id) {
  return requireToolkit().services.providers.refreshProviderModels(id);
}

/**
 * Probe a provider's model list without persisting it. Pair with
 * `updateProvider(id, { models })` to apply one probe's result to several
 * providers that share an upstream.
 */
export async function fetchProviderModels(id) {
  return requireToolkit().services.providers.fetchProviderModels(id);
}

/**
 * Refresh a whole set of providers with ONE providers.json write: the toolkit
 * groups them by shared Ollama daemon + probe shape, probes one lead per group,
 * then applies every result in a single save. Returns one result per group so
 * the caller logs group-level context instead of one line per member.
 */
export async function refreshProviderModelsBatch(ids) {
  return requireToolkit().services.providers.refreshProviderModelsBatch(ids);
}
