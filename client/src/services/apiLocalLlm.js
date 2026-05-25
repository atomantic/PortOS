import { request } from './apiCore.js';

// Local LLM backends (Ollama / LM Studio) — status, model management, migrate.
// Installed models per backend come back inside getLocalLlmStatus().
export const getLocalLlmStatus = () => request('/local-llm/status');

export const getLocalLlmCatalog = (backend, q = '') =>
  request(`/local-llm/catalog?backend=${encodeURIComponent(backend)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

export const getLocalLlmHuggingFaceSearch = (backend, q = '', category = 'all', limit = 12) =>
  request(`/local-llm/huggingface-search?backend=${encodeURIComponent(backend)}&category=${encodeURIComponent(category)}&limit=${encodeURIComponent(limit)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

export const installLocalLlmModel = (backend, modelId) =>
  request('/local-llm/install', { method: 'POST', body: JSON.stringify({ backend, modelId }) });

export const deleteLocalLlmModel = (backend, modelId) =>
  request('/local-llm/delete', { method: 'POST', body: JSON.stringify({ backend, modelId }) });

export const installLocalLlmBackend = (backend) =>
  request('/local-llm/install-backend', { method: 'POST', body: JSON.stringify({ backend }) });

export const controlOllamaService = (action) =>
  request('/local-llm/ollama-service', { method: 'POST', body: JSON.stringify({ action }) });

// Set the default backend (which one PortOS routes local runs to) — does not move models.
export const switchLocalLlmBackend = (to) =>
  request('/local-llm/switch', { method: 'POST', body: JSON.stringify({ to }) });

// Move the OTHER backend's models onto `to`. mode: 'link' shares GGUF weights on
// disk (default, zero extra space, falls back to copy across filesystems);
// 'copy' makes an independent duplicate. Never changes the default backend.
export const migrateLocalLlmBackend = (to, mode = 'link') =>
  request('/local-llm/migrate', { method: 'POST', body: JSON.stringify({ to, mode }) });
