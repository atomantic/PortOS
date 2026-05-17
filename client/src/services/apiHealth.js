import { request } from './apiCore.js';

// Apple Health
export const ingestAppleHealth = (data) => request('/health/ingest', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getAppleHealthMetrics = (metricName, from, to) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/health/metrics/${metricName}/daily?${params}`);
};
export const getAppleHealthSummary = (metricName, from, to) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/health/metrics/${metricName}?${params}`);
};
export const getAvailableHealthMetrics = () => request('/health/metrics/available');
export const getLatestHealthMetrics = (metricNames) =>
  request(`/health/metrics/latest?metrics=${metricNames.join(',')}`);
export const getAppleHealthRange = () => request('/health/range');
export const getAppleHealthCorrelation = (from, to) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/health/correlation?${params}`);
};
export const uploadAppleHealthXml = (file, options = {}) => {
  const formData = new FormData();
  formData.append('file', file);
  // request() detects FormData bodies and lets the browser set the multipart
  // boundary automatically. Accept `options` so callers with their own error
  // UI can pass `{ silent: true }` to suppress the helper's toast.
  return request('/health/import/xml', { method: 'POST', body: formData, ...options });
};

// Genome / Health Correlations
export const getGenomeHealthCorrelations = () => request('/insights/genome-health');
