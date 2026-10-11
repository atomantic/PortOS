import { request } from './apiCore.js';

// Signal Desktop ingestion (#2154, #11149) — read-only SQLCipher snapshot of the
// local chat DB (keychain-wrapped key, committed WAL frames included).
// Machine-local; OFF by default. These wrappers drive the settings tab.
export const getSignalStatus = (options = {}) => request('/signal/status', options);
export const checkSignalSetup = (options = {}) => request('/signal/setup-check', options);
export const syncSignal = (options = {}) => request('/signal/sync', { method: 'POST', ...options });
