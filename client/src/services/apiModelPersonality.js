import { request } from './apiCore.js';

// Model Personality — LLM personality self-profile testing with optional
// digital-twin alignment scoring (issue #2610).

export const runModelPersonalityTest = (data, options = {}) => request('/model-personality/run', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const getModelPersonalityHistory = (limit, options = {}) =>
  request(`/model-personality/history${limit ? `?limit=${limit}` : ''}`, options);
export const deleteModelPersonalityResult = (runId, options = {}) =>
  request(`/model-personality/history/${runId}`, { method: 'DELETE', ...options });
export const getModelPersonalitySettings = (options = {}) => request('/model-personality/settings', options);
export const updateModelPersonalitySettings = (data, options = {}) => request('/model-personality/settings', {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
