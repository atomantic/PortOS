import { request } from './apiCore.js';
export const getModelComparison = (options) => request('/providers/comparison', options);

export const discoverComparisonModels = (providerId, options) => request('/providers/comparison/discover', {
  method: 'POST', body: JSON.stringify({ providerId }), ...options,
});

export const runPortosModelBenchmark = (selection, options) => request('/providers/comparison/run', {
  method: 'POST', body: JSON.stringify(selection), ...options,
});
