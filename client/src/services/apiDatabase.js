import { request } from './apiCore.js';

// Database
export const getDatabaseStatus = () => request('/database/status');
export const switchDatabase = (target, migrate = false) => request('/database/switch', {
  method: 'POST',
  body: JSON.stringify({ target, migrate })
});
export const setupNativeDatabase = () => request('/database/setup-native', { method: 'POST' });
export const exportDatabase = (backend) => request('/database/export', {
  method: 'POST',
  ...(backend ? { body: JSON.stringify({ backend }) } : {})
});
export const fixDatabase = () => request('/database/fix', { method: 'POST' });
export const syncDatabase = () => request('/database/sync', { method: 'POST' });
export const startDatabase = (backend) => request('/database/start', {
  method: 'POST',
  body: JSON.stringify({ backend })
});
export const stopDatabase = (backend) => request('/database/stop', {
  method: 'POST',
  body: JSON.stringify({ backend })
});
export const destroyDatabase = (backend) => request('/database/destroy', {
  method: 'POST',
  body: JSON.stringify({ backend })
});
