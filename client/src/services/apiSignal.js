import { request } from './apiCore.js';

// Signal Desktop ingestion (#2154) — read the SQLCipher-encrypted chat DB (via
// the keychain-wrapped key) into the Tribe touchpoint log + activity timeline.
// Machine-local; OFF by default. These wrappers drive the settings tab.
export const getSignalStatus = (options = {}) => request('/signal/status', options);
export const checkSignalSetup = (options = {}) => request('/signal/setup-check', options);
export const syncSignal = (options = {}) => request('/signal/sync', { method: 'POST', ...options });
