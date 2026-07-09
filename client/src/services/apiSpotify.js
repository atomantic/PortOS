import { request } from './apiCore.js';

// Spotify listening-history ingestion (#2152) — OAuth + recently-played polling
// into the machine-local activity timeline. Credentials/tokens live server-side
// under data/spotify/; these wrappers drive the settings tab.
export const getSpotifyStatus = (options = {}) => request('/spotify/status', options);
export const getSpotifyAuthUrl = (options = {}) => request('/spotify/auth/url', options);
export const saveSpotifyCredentials = (data, options = {}) =>
  request('/spotify/auth/credentials', { method: 'POST', body: JSON.stringify(data), ...options });
export const clearSpotifyAuth = (options = {}) =>
  request('/spotify/auth/clear', { method: 'POST', ...options });
export const syncSpotify = (options = {}) => request('/spotify/sync', { method: 'POST', ...options });
