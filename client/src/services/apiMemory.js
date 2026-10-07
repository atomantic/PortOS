import { request } from './apiCore.js';

// Memory
export const getMemories = (options = {}, requestOptions = {}) => {
  const params = new URLSearchParams();
  if (options.types) params.set('types', options.types.join(','));
  if (options.categories) params.set('categories', options.categories.join(','));
  if (options.tags) params.set('tags', options.tags.join(','));
  if (options.status) params.set('status', options.status);
  if (options.appId) params.set('appId', options.appId);
  if (options.sourceAgentId) params.set('sourceAgentId', options.sourceAgentId);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  if (options.sortBy) params.set('sortBy', options.sortBy);
  if (options.sortOrder) params.set('sortOrder', options.sortOrder);
  return request(`/memory?${params}`, requestOptions);
};
export const getMemory = (id, options) => request(`/memory/${id}`, options);
export const getMemoryVersion = (id, version, options) => request(`/memory/${id}?version=${version}`, options);
export const getMemoryVersions = (id, offset = 0, options) => request(`/memory/${id}/versions?limit=20&offset=${offset}`, options);
export const getMemoryRuns = (id, options) => request(`/memory/${id}/runs`, options);
export const updateMemory = (id, data, options = {}) => request(`/memory/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteMemory = (id, hard = false) => request(`/memory/${id}?hard=${hard}`, { method: 'DELETE' });
export const searchMemories = (query, options = {}, requestOptions = {}) => request('/memory/search', {
  method: 'POST',
  body: JSON.stringify({ query, ...options }),
  ...requestOptions
});
export const getMemoryGraph = (options = {}) => request('/memory/graph', options);
export const getMemoryStats = (options) => request('/memory/stats', options);
export const getEmbeddingStatus = () => request('/memory/embeddings/status');
export const getMemoryBackendStatus = () => request('/memory/backend/status', { silent: true });
export const approveMemory = (id, options = {}) => request(`/memory/${id}/approve`, { method: 'POST', ...options });
export const rejectMemory = (id, options = {}) => request(`/memory/${id}/reject`, { method: 'POST', ...options });
