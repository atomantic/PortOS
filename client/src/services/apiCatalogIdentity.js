import { request } from './apiCore.js';

export const listCatalogIdentities = ({ ingredientId, limit = 10, offset = 0, ...options } = {}) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (ingredientId) params.set('ingredientId', ingredientId);
  return request(`/catalog/identity?${params}`, options);
};
export const getCatalogIdentity = (id, options) => request(`/catalog/identity/${encodeURIComponent(id)}`, options);
export const previewCatalogIdentity = (body, options) => request('/catalog/identity/preview', { method: 'POST', body: JSON.stringify(body), ...options });
export const createCatalogIdentity = (body, options) => request('/catalog/identity/create', { method: 'POST', body: JSON.stringify(body), ...options });
export const importCatalogIdentity = (body, options) => request('/catalog/identity/import', { method: 'POST', body: JSON.stringify(body), ...options });
export const acceptCatalogIdentity = (id, planHash, options) => request(`/catalog/identity/${encodeURIComponent(id)}/accept`, { method: 'POST', body: JSON.stringify({ planHash }), ...options });
export const advanceCatalogIdentity = (id, options) => request(`/catalog/identity/${encodeURIComponent(id)}/advance`, { method: 'POST', body: JSON.stringify({}), ...options });
export const abortCatalogIdentity = (id, options) => request(`/catalog/identity/${encodeURIComponent(id)}/abort`, { method: 'POST', body: JSON.stringify({}), ...options });
export const recoverCatalogIdentity = (id, planHash, options) => request(`/catalog/identity/${encodeURIComponent(id)}/recover`, { method: 'POST', body: JSON.stringify({ planHash }), ...options });
