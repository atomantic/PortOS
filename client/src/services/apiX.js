import { request } from './apiCore.js';

export const getXAccounts = (options = {}) => request('/x/accounts', options);
export const getXAccount = (id, options = {}) => request(`/x/accounts/${id}`, options);
export const createXAccount = (data, options = {}) => request('/x/accounts', { method: 'POST', body: JSON.stringify(data), ...options });
export const updateXAccount = (id, data, options = {}) => request(`/x/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data), ...options });
export const deleteXAccount = (id, options = {}) => request(`/x/accounts/${id}`, { method: 'DELETE', ...options });
export const syncXAccount = (id, options = {}) => request(`/x/accounts/${id}/sync`, { method: 'POST', ...options });
export const openXAccountDestination = (id, kind, options = {}) => request(`/x/accounts/${id}/open`, { method: 'POST', body: JSON.stringify({ kind }), ...options });
export const getXPosts = (accountId, options = {}) => request(`/x/accounts/${accountId}/posts`, options);
export const getXDrafts = (accountId, options = {}) => request(`/x/accounts/${accountId}/drafts`, options);
export const createXDraft = (data, options = {}) => request('/x/drafts', { method: 'POST', body: JSON.stringify(data), ...options });
export const reviewXDraft = (id, data, options = {}) => request(`/x/drafts/${id}/review`, { method: 'POST', body: JSON.stringify(data), ...options });
export const openXDraft = (id, options = {}) => request(`/x/drafts/${id}/open`, { method: 'POST', ...options });
