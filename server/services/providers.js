/**
 * Compatibility shim for PortOS services that import from providers.js
 * Re-exports toolkit provider service functions
 */

// This will be initialized by server/index.js and set via setAIToolkit()
let aiToolkitInstance = null;

export function setAIToolkit(toolkit) {
  aiToolkitInstance = toolkit;
}

export async function getAllProviders() {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.getAllProviders();
}

export async function getProviderById(id) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.getProviderById(id);
}

export async function getActiveProvider() {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.getActiveProvider();
}

export async function setActiveProvider(id) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.setActiveProvider(id);
}

export async function createProvider(data) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.createProvider(data);
}

export async function updateProvider(id, data) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.updateProvider(id, data);
}

export async function deleteProvider(id) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.deleteProvider(id);
}

export async function testProvider(id) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.testProvider(id);
}

export async function refreshProviderModels(id) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.providers.refreshProviderModels(id);
}
