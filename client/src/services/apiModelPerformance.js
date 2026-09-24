import { request } from './apiCore.js';

const PATH = '/models/performance/task-benchmark';

export const getModelPerformanceBenchmarks = (options) => request(PATH, options);

export const discoverModelPerformanceModels = (providerId, options) => request(`${PATH}/discover`, {
  method: 'POST', body: JSON.stringify({ providerId }), ...options,
});

export const runModelPerformanceBenchmark = (selection, options) => request(`${PATH}/run`, {
  method: 'POST', body: JSON.stringify(selection), ...options,
});
