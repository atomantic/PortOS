import { request } from './apiCore.js';

export const getMortalLoomStatus = () => request('/mortalloom/status');
export const importMortalLoom = (options) => request('/mortalloom/import', { method: 'POST', ...options });
export const getMortalLoomAppStoreUrl = () => request('/mortalloom/app-store');
