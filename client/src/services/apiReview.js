import { request, queryString } from './apiCore.js';

// Review Hub
export const getReviewItems = (params) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.type) qs.set('type', params.type);
  const query = qs.toString();
  return request(`/review/items${query ? `?${query}` : ''}`);
};
export const getReviewCounts = (options = {}) => request('/review/counts', options);
export const getReviewBriefing = () => request('/review/briefing');
// Cross-domain live queue (source-owned obligations plus domain projections).
// Keep transport options (silent, headers, abort signal) separate from the
// pagination query so callers can continue using the old options-only shape.
export const getReviewQueue = ({ view, limit, cursor, ...options } = {}) => {
  const query = queryString({ view, limit, cursor });
  return request(`/review/queue${query}`, options);
};
// Resolve a single queue row in place (id is `<source>:<rawId>`). Source-owned
// approvals may pass `operation` (approve/reject); transport options stay out
// of the JSON body.
export const resolveReviewQueueItem = (id, { operation, ...options } = {}) => request('/review/queue/resolve', {
  method: 'POST',
  body: JSON.stringify({ id, ...(operation ? { operation } : {}) }),
  ...options
});
// Promote an Ask row's latest assistant answer into Brain, a CoS task, or a
// Goal's progress in place (id is `ask:<conversationId>`, target is
// 'brain' | 'task' | 'goal'; goalId is required for the 'goal' target).
export const promoteAskReviewQueueItem = (id, target, { goalId, ...options } = {}) => request('/review/queue/promote-ask', {
  method: 'POST',
  body: JSON.stringify({ id, target, ...(goalId ? { goalId } : {}) }),
  ...options
});
export const createReviewTodo = (data) => request('/review/todo', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateReviewItem = (id, data, options = {}) => request(`/review/items/${id}`, {
  method: 'PATCH',
  body: JSON.stringify(data),
  ...options
});
export const completeReviewItem = (id) => request(`/review/items/${id}/complete`, { method: 'POST' });
export const dismissReviewItem = (id) => request(`/review/items/${id}/dismiss`, { method: 'POST' });
export const deleteReviewItem = (id) => request(`/review/items/${id}`, { method: 'DELETE' });
export const bulkUpdateReviewStatus = ({ status, ids }) => request('/review/items/bulk-status', {
  method: 'POST',
  body: JSON.stringify({ status, ...(ids ? { ids } : {}) })
});
