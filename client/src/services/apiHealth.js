import { request, API_BASE } from './apiCore.js';

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
export const uploadAppleHealthXml = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  // Use fetch directly — the request helper sets Content-Type: application/json
  // which conflicts with multipart/form-data. Browser sets correct boundary automatically.
  return fetch(`${API_BASE}/health/import/xml`, {
    method: 'POST',
    body: formData,
  }).then(async res => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  });
};

// Genome / Health Correlations
export const getGenomeHealthCorrelations = () => request('/insights/genome-health');
