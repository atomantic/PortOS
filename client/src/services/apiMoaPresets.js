/**
 * Mixture of Agents preset API (`/api/moa-presets`): list with live member eligibility, create, update, delete.
 *
 * A preset runs wherever a provider is selected, as provider id `moa:<id>`.
 */

import { request } from './apiCore.js';

export const listMoaPresets = (options = {}) => request('/moa-presets', options);
export const createMoaPreset = (data, options = {}) => request('/moa-presets', {
  method: 'POST', body: JSON.stringify(data), ...options,
});
export const updateMoaPreset = (id, data, options = {}) => request(`/moa-presets/${encodeURIComponent(id)}`, {
  method: 'PUT', body: JSON.stringify(data), ...options,
});
export const deleteMoaPreset = (id, options = {}) => request(`/moa-presets/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
