import { request } from './apiCore.js';

// macOS Contacts ingestion + Tribe bridge (#2415).
export const getContactsStatus = (options = {}) => request('/contacts/status', options);
export const checkContactsSetup = (options = {}) => request('/contacts/setup-check', options);
export const syncContacts = (options = {}) => request('/contacts/sync', { method: 'POST', ...options });
export const searchContacts = ({ q, limit, silent } = {}) => {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return request(`/contacts/search${qs ? `?${qs}` : ''}`, { silent });
};
export const resolveContactHandle = (handle, options = {}) =>
  request(`/contacts/resolve?handle=${encodeURIComponent(handle)}`, options);
export const enrichTribeFromContacts = ({ dryRun = false, ...options } = {}) =>
  request('/contacts/enrich-tribe', {
    method: 'POST',
    body: JSON.stringify({ dryRun }),
    ...options,
  });
export const suggestTribeFromContacts = ({ limit, silent } = {}) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return request(`/contacts/suggest-tribe${qs ? `?${qs}` : ''}`, { silent });
};
export const importContactToTribe = (data, options = {}) =>
  request('/contacts/import-to-tribe', {
    method: 'POST',
    body: JSON.stringify(data),
    ...options,
  });
