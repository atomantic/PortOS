import { request } from './apiCore.js';

// Database
export const getDatabaseStatus = (options) => request('/database/status', options);
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

// Coordinated offline backend cutover (#8811). The journal survives the
// server's own restart, so status reads work before/after that gap too.
export const getDatabaseMaintenanceStatus = (options) => request('/database/maintenance/status', { silent: true, ...options });
export const cutoverDatabase = (direction) => request('/database/maintenance/cutover', {
  method: 'POST',
  body: JSON.stringify(direction)
});
export const recoverDatabaseCutover = (id) => request('/database/maintenance/recover', {
  method: 'POST',
  body: JSON.stringify({ id })
});
