import { request } from './apiCore.js';

export const getStackerNewsAccounts = (options = {}) => request('/stacker-news/accounts', options);
export const createStackerNewsAccount = (data, options = {}) => request('/stacker-news/accounts', { method: 'POST', body: JSON.stringify(data), ...options });
export const updateStackerNewsAccount = (id, data, options = {}) => request(`/stacker-news/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data), ...options });
// `transport` forces which read source answers ('api' | 'browser'); omit it to
// use the account's configured read transport.
export const verifyStackerNewsAccount = (id, transport = null, options = {}) => request(`/stacker-news/accounts/${id}/verify`, { method: 'POST', body: JSON.stringify(transport ? { transport } : {}), ...options });
export const getStackerNewsBrowserIdentity = (id, options = {}) => request(`/stacker-news/accounts/${id}/browser-identity`, { method: 'POST', ...options });
export const syncStackerNewsAccount = (id, options = {}) => request(`/stacker-news/accounts/${id}/sync`, { method: 'POST', ...options });
export const getStackerNewsTerritories = (accountId, options = {}) => request(`/stacker-news/accounts/${accountId}/territories`, options);
export const createStackerNewsTerritory = (data, options = {}) => request('/stacker-news/territories', { method: 'POST', body: JSON.stringify(data), ...options });
export const updateStackerNewsTerritory = (id, data, options = {}) => request(`/stacker-news/territories/${id}`, { method: 'PATCH', body: JSON.stringify(data), ...options });
export const deleteStackerNewsTerritory = (id, options = {}) => request(`/stacker-news/territories/${id}`, { method: 'DELETE', ...options });
export const getStackerNewsItems = (accountId, options = {}) => request(`/stacker-news/accounts/${accountId}/items`, options);
export const getStackerNewsActions = (accountId, options = {}) => request(`/stacker-news/accounts/${accountId}/actions`, options);
export const analyzeStackerNewsItem = (id, options = {}) => request(`/stacker-news/items/${id}/analyze`, { method: 'POST', ...options });
export const addStackerNewsAnalysisFeedback = (id, feedback, options = {}) => request(`/stacker-news/analyses/${id}/feedback`, { method: 'POST', body: JSON.stringify({ feedback }), ...options });
export const createStackerNewsAction = (data, options = {}) => request('/stacker-news/actions', { method: 'POST', body: JSON.stringify(data), ...options });
export const reviewStackerNewsAction = (id, data, options = {}) => request(`/stacker-news/actions/${id}/review`, { method: 'POST', body: JSON.stringify(data), ...options });
export const executeStackerNewsAction = (id, options = {}) => request(`/stacker-news/actions/${id}/execute`, { method: 'POST', ...options });
