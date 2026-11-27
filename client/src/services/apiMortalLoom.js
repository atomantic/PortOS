/**
 * Mortality tracking.
 */

import { request } from './apiCore.js';

export const getMortalLoomStatus = (options) => request('/mortalloom/status', options);
export const importMortalLoom = (options) => request('/mortalloom/import', { method: 'POST', ...options });

export const restoreMortalLoom = (snapshot, options) => request('/mortalloom/restore', {
  ...options, method: 'POST', body: JSON.stringify({ ...snapshot, confirmed: true }),
});

export const downloadMortalLoomRecovery = (id, options) => request('/mortalloom/recovery/download', {
  ...options, method: 'POST', responseType: 'blob', body: JSON.stringify({ id }),
});

export const previewMortalLoomRecovery = (id, options) => request('/mortalloom/recovery/preview', {
  ...options, method: 'POST', body: JSON.stringify({ id }),
});
