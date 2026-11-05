import { request } from './apiCore.js';

// Loops
export const getLoops = (options = {}) => request('/loops', options);
export const getLoopProviders = () => request('/loops/providers');
export const createLoop = (data) => request('/loops', { method: 'POST', body: JSON.stringify(data) });
export const stopLoop = (id) => request(`/loops/${id}/stop`, { method: 'POST' });
export const resumeLoop = (id) => request(`/loops/${id}/resume`, { method: 'POST' });
export const triggerLoop = (id) => request(`/loops/${id}/trigger`, { method: 'POST' });
export const deleteLoop = (id) => request(`/loops/${id}`, { method: 'DELETE' });
