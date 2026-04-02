import { request } from './apiCore.js';

// Memory
export const getMemories = (options = {}) => {
  const params = new URLSearchParams();
  if (options.types) params.set('types', options.types.join(','));
  if (options.categories) params.set('categories', options.categories.join(','));
  if (options.tags) params.set('tags', options.tags.join(','));
  if (options.status) params.set('status', options.status);
  if (options.appId) params.set('appId', options.appId);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  if (options.sortBy) params.set('sortBy', options.sortBy);
  if (options.sortOrder) params.set('sortOrder', options.sortOrder);
  return request(`/memory?${params}`);
};
export const getMemory = (id) => request(`/memory/${id}`);
export const createMemory = (data) => request('/memory', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateMemory = (id, data) => request(`/memory/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteMemory = (id, hard = false) => request(`/memory/${id}?hard=${hard}`, { method: 'DELETE' });
export const searchMemories = (query, options = {}) => request('/memory/search', {
  method: 'POST',
  body: JSON.stringify({ query, ...options })
});
export const getMemoryCategories = () => request('/memory/categories');
export const getMemoryTags = () => request('/memory/tags');
export const getMemoryTimeline = (options = {}) => {
  const params = new URLSearchParams();
  if (options.startDate) params.set('startDate', options.startDate);
  if (options.endDate) params.set('endDate', options.endDate);
  if (options.types) params.set('types', options.types.join(','));
  if (options.limit) params.set('limit', options.limit);
  return request(`/memory/timeline?${params}`);
};
export const getMemoryGraph = () => request('/memory/graph');
export const getMemoryStats = () => request('/memory/stats');
export const getRelatedMemories = (id, limit = 10) => request(`/memory/${id}/related?limit=${limit}`);
export const linkMemories = (sourceId, targetId) => request('/memory/link', {
  method: 'POST',
  body: JSON.stringify({ sourceId, targetId })
});
export const consolidateMemories = (options = {}) => request('/memory/consolidate', {
  method: 'POST',
  body: JSON.stringify(options)
});
export const getEmbeddingStatus = () => request('/memory/embeddings/status');
export const getMemoryBackendStatus = () => request('/memory/backend/status', { silent: true });
export const approveMemory = (id) => request(`/memory/${id}/approve`, { method: 'POST' });
export const rejectMemory = (id) => request(`/memory/${id}/reject`, { method: 'POST' });
