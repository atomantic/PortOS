import { request } from './apiCore.js';
export const getModelComparison = (options) => request('/providers/comparison', options);
export const importModelComparison = (catalog, options) => request('/providers/comparison/import', {
  method: 'POST', body: JSON.stringify(catalog), ...options,
});

export const discoverComparisonModels = (providerId, options) => request('/providers/comparison/discover', {
  method: 'POST', body: JSON.stringify({ providerId }), ...options,
});

export const syncArtificialAnalysis = (data, options) => request('/providers/comparison/sync-aa', {
  method: 'POST', body: JSON.stringify(data || {}), ...options,
});
