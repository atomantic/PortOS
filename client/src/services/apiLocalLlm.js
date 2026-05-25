import { request } from './apiCore.js';

// Local LLM backends (Ollama / LM Studio) — status, model management, migrate.
// Installed models per backend come back inside getLocalLlmStatus().
export const getLocalLlmStatus = () => request('/local-llm/status');

export const getLocalLlmCatalog = (backend, q = '') =>
  request(`/local-llm/catalog?backend=${encodeURIComponent(backend)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

export const installLocalLlmModel = (backend, modelId) =>
  request('/local-llm/install', { method: 'POST', body: JSON.stringify({ backend, modelId }) });

export const deleteLocalLlmModel = (backend, modelId) =>
  request('/local-llm/delete', { method: 'POST', body: JSON.stringify({ backend, modelId }) });

export const installLocalLlmBackend = (backend) =>
  request('/local-llm/install-backend', { method: 'POST', body: JSON.stringify({ backend }) });

export const switchLocalLlmBackend = (to) =>
  request('/local-llm/switch', { method: 'POST', body: JSON.stringify({ to }) });

export const migrateLocalLlmBackend = (to) =>
  request('/local-llm/migrate', { method: 'POST', body: JSON.stringify({ to }) });
