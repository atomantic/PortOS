/**
 * Mortality tracking.
 */

import { request } from './apiCore.js';

export const getMortalLoomStatus = (options) => request('/mortalloom/status', options);
export const importMortalLoom = (options) => request('/mortalloom/import', { method: 'POST', ...options });
