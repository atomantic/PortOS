import { request } from './apiCore.js';

// Runs
export const getRuns = (limit = 50, offset = 0, source = 'all') =>
  request(`/runs?limit=${limit}&offset=${offset}&source=${source}`);
export const createRun = (data) => request('/runs', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getRun = (id) => request(`/runs/${id}`);
export const getRunOutput = (id) => request(`/runs/${id}/output`);
export const getRunPrompt = (id) => request(`/runs/${id}/prompt`);
export const stopRun = (id) => request(`/runs/${id}/stop`, { method: 'POST' });
export const deleteRun = (id) => request(`/runs/${id}`, { method: 'DELETE' });
export const deleteFailedRuns = () => request('/runs?filter=failed', { method: 'DELETE' });
