import { request } from './apiCore.js';

export const getModelPerformanceBenchmarks = (options) => request('/models/performance/task-benchmark', options);

export const discoverModelPerformanceModels = (providerId, options) => request('/models/performance/task-benchmark/discover', {
  method: 'POST', body: JSON.stringify({ providerId }), ...options,
});

export const runModelPerformanceBenchmark = (selection, options) => request('/models/performance/task-benchmark/run', {
  method: 'POST', body: JSON.stringify(selection), ...options,
});
