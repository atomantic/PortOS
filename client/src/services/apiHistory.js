import { request } from './apiCore.js';

// History
export const getHistory = (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  if (options.action) params.set('action', options.action);
  if (options.success !== undefined) params.set('success', options.success);
  return request(`/history?${params}`);
};
export const getHistoryStats = () => request('/history/stats');
export const getHistoryActions = () => request('/history/actions');
export const clearHistory = (olderThanDays) => request(
  olderThanDays ? `/history?olderThanDays=${olderThanDays}` : '/history',
  { method: 'DELETE' }
);
export const deleteHistoryEntry = (id) => request(`/history/${id}`, { method: 'DELETE' });
