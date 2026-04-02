import { request } from './apiCore.js';

// Providers
export const getProviders = () => request('/providers');
export const getActiveProvider = () => request('/providers/active');
export const setActiveProvider = (id) => request('/providers/active', {
  method: 'PUT',
  body: JSON.stringify({ id })
});
export const getProvider = (id) => request(`/providers/${id}`);
export const createProvider = (data) => request('/providers', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateProvider = (id, data) => request(`/providers/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteProvider = (id) => request(`/providers/${id}`, { method: 'DELETE' });
export const getSampleProviders = () => request('/providers/samples');
export const testProvider = (id) => request(`/providers/${id}/test`, { method: 'POST' });
export const refreshProviderModels = (id) => request(`/providers/${id}/refresh-models`, { method: 'POST' });

// Provider status (usage limits, availability)
export const getProviderStatuses = () => request('/providers/status');
export const getProviderStatus = (id) => request(`/providers/${id}/status`);
export const recoverProvider = (id) => request(`/providers/${id}/status/recover`, { method: 'POST' });
