import { request } from './apiCore.js';

// Local LLM backends (Ollama / LM Studio) — status, model management, migrate.
// Installed models per backend come back inside getLocalLlmStatus().
export const getLocalLlmStatus = (options) => request('/local-llm/status', options);

export const getLocalLlmCatalog = (backend, q = '') =>
  request(`/local-llm/catalog?backend=${encodeURIComponent(backend)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

export const getLocalLlmHuggingFaceSearch = (backend, q = '', category = 'all', limit = 12) =>
  request(`/local-llm/huggingface-search?backend=${encodeURIComponent(backend)}&category=${encodeURIComponent(category)}&limit=${encodeURIComponent(limit)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

// `options` lets callers opt into `{ silent: true }` so structured failure codes
// (e.g. OLLAMA_OUTDATED → offer to upgrade in place) can be handled by the UI
// without the default error toast firing first and stacking with the prompt.
export const installLocalLlmModel = (backend, modelId, options) =>
  request('/local-llm/install', { method: 'POST', body: JSON.stringify({ backend, modelId }), ...options });

export const deleteLocalLlmModel = (backend, modelId) =>
  request('/local-llm/delete', { method: 'POST', body: JSON.stringify({ backend, modelId }) });

export const installLocalLlmBackend = (backend) =>
  request('/local-llm/install-backend', { method: 'POST', body: JSON.stringify({ backend }) });

// Upgrade an already-installed backend in place (Homebrew on macOS, official
// Ollama script on Linux). The pull-model path uses this on the OLLAMA_OUTDATED
// recovery flow so a stale binary doesn't keep the user from installing new models.
export const upgradeLocalLlmBackend = (backend) =>
  request('/local-llm/upgrade-backend', { method: 'POST', body: JSON.stringify({ backend }) });

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

// Memory-management — models currently resident in VRAM/unified memory.
// Used by the Memory Management panel to show what's eating space before
// kicking off a big diffusion render. `options` lets the panel pass
// `{ silent: true }` so its own catch handler / useAsyncAction wrapper
// owns the toast — without it apiCore double-toasts on every 5s poll.
export const getLoadedLlmModels = (options) =>
  request('/local-llm/loaded', options);

// Force Ollama to evict a model immediately. LM Studio has its own
// /api/lmstudio/unload endpoint (see apiCore default export usage in
// LocalLlmTab) — we don't proxy it through this module.
export const unloadOllamaModel = (modelId, options) =>
  request('/local-llm/unload', {
    method: 'POST',
    body: JSON.stringify({ backend: 'ollama', modelId }),
    ...options,
  });

export const testLocalLlmModel = (payload, options) =>
  request('/local-llm/test', { method: 'POST', body: JSON.stringify(payload), ...options });

export const compareLocalLlmModels = (payload, options) =>
  request('/local-llm/compare', { method: 'POST', body: JSON.stringify(payload), ...options });
