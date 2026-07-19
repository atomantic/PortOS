import { request } from './apiCore.js';

// GitHub Repos
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// when it already renders its own error UI.
export const getGitHubRepos = (options = {}) => request('/github/repos', options);
export const syncGitHubRepos = (options = {}) => request('/github/repos/sync', { method: 'POST', ...options });
export const updateGitHubRepo = (fullName, data, options = {}) =>
  request(`/github/repos/${encodeURIComponent(fullName)}`, { method: 'PUT', body: JSON.stringify(data), ...options });
export const archiveGitHubRepo = (fullName, options = {}) =>
  request(`/github/repos/${encodeURIComponent(fullName)}/archive`, { method: 'POST', ...options });
export const unarchiveGitHubRepo = (fullName, options = {}) =>
  request(`/github/repos/${encodeURIComponent(fullName)}/unarchive`, { method: 'POST', ...options });
export const getGitHubSecrets = (options = {}) => request('/github/secrets', options);
export const setGitHubSecret = (name, value, options = {}) =>
  request(`/github/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }), ...options });
export const syncGitHubSecret = (name, options = {}) =>
  request(`/github/secrets/${encodeURIComponent(name)}/sync`, { method: 'POST', ...options });
