import { request } from './apiCore.js';

// Review Hub
export const getReviewItems = (params) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.type) qs.set('type', params.type);
  const query = qs.toString();
  return request(`/review/items${query ? `?${query}` : ''}`);
};
export const getReviewCounts = () => request('/review/counts');
export const getReviewBriefing = () => request('/review/briefing');
export const createReviewTodo = (data) => request('/review/todo', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateReviewItem = (id, data) => request(`/review/items/${id}`, {
  method: 'PATCH',
  body: JSON.stringify(data)
});
export const completeReviewItem = (id) => request(`/review/items/${id}/complete`, { method: 'POST' });
export const dismissReviewItem = (id) => request(`/review/items/${id}/dismiss`, { method: 'POST' });
export const deleteReviewItem = (id) => request(`/review/items/${id}`, { method: 'DELETE' });
export const bulkUpdateReviewStatus = ({ status, ids }) => request('/review/items/bulk-status', {
  method: 'POST',
  body: JSON.stringify({ status, ...(ids ? { ids } : {}) })
});
