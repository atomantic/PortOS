/**
 * Compatibility shim for PortOS services that import from providers.js
 * Re-exports toolkit provider service functions
 */

import { ServerError } from '../lib/errorHandler.js';

// This will be initialized by server/index.js and set via setAIToolkit()
let aiToolkitInstance = null;

export function setAIToolkit(toolkit) {
  aiToolkitInstance = toolkit;
}

// Centralized typed-error so callers can gate on `err.code === 'AI_TOOLKIT_NOT_INITIALIZED'`
// instead of string-matching the message; status 503 (service-unavailable)
// because the toolkit warms at boot and a not-initialized state means the
// service hasn't finished starting.
function requireToolkit() {
  if (aiToolkitInstance) return aiToolkitInstance;
  throw new ServerError('AI Toolkit not initialized', {
    status: 503,
    code: 'AI_TOOLKIT_NOT_INITIALIZED',
  });
}

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
