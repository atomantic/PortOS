import { request } from './apiCore.js';

// GitHub Repos
export const getGitHubRepos = () => request('/github/repos');
export const syncGitHubRepos = () => request('/github/repos/sync', { method: 'POST' });
export const updateGitHubRepo = (fullName, data) =>
  request(`/github/repos/${encodeURIComponent(fullName)}`, { method: 'PUT', body: JSON.stringify(data) });
export const archiveGitHubRepo = (fullName) =>
  request(`/github/repos/${encodeURIComponent(fullName)}/archive`, { method: 'POST' });
export const unarchiveGitHubRepo = (fullName) =>
  request(`/github/repos/${encodeURIComponent(fullName)}/unarchive`, { method: 'POST' });
export const getGitHubSecrets = () => request('/github/secrets');
export const setGitHubSecret = (name, value) =>
  request(`/github/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) });
export const syncGitHubSecret = (name) =>
  request(`/github/secrets/${encodeURIComponent(name)}/sync`, { method: 'POST' });
