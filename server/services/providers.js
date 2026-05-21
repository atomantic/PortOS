/**
 * Compatibility shim for PortOS services that import from providers.js
 * Re-exports toolkit provider service functions
 */

import { setAIToolkitInstance, requireToolkit } from '../lib/aiToolkitState.js';

// `server/index.js` imports `setAIToolkit` from here — keep the named export
// stable while the underlying singleton lives in `lib/aiToolkitState.js` so
// providers / runner / promptService all observe the same instance.
export const setAIToolkit = setAIToolkitInstance;

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
