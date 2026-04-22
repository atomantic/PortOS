import { request } from './apiCore.js';

export const getMortalLoomStatus = () => request('/mortalloom/status');
export const importMortalLoom = () => request('/mortalloom/import', { method: 'POST' });
export const getMortalLoomAppStoreUrl = () => request('/mortalloom/app-store');
