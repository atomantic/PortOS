/**
 * Agent run history.
 */

import { request } from './apiCore.js';

// Runs
export const getRuns = (limit = 50, offset = 0, source = 'all', options) =>
  request(`/runs?limit=${limit}&offset=${offset}&source=${source}`, options);
export const createRun = (data, options) => request('/runs', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
// These endpoints deliberately return text/plain. A model response can itself
// be valid JSON; forcing the shared request helper's default JSON parser turns
// it into an object that React cannot render inside <pre>.
export const getRunOutput = (id, options) => request(`/runs/${id}/output`, { ...options, responseType: 'text' });
export const getRunPrompt = (id, options) => request(`/runs/${id}/prompt`, { ...options, responseType: 'text' });
export const stopRun = (id) => request(`/runs/${id}/stop`, { method: 'POST' });
export const deleteRun = (id) => request(`/runs/${id}`, { method: 'DELETE' });
export const deleteFailedRuns = () => request('/runs?filter=failed', { method: 'DELETE' });
export const getRun = (id, options) => request(`/runs/${encodeURIComponent(id)}`, options);
