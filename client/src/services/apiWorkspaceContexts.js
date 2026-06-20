import { request } from './apiCore.js';

// Workspace Contexts (#902) — per-project working-context save/restore.
// `options` lets callers opt into silent mode when they own their error UI.
export const listWorkspaceContexts = (options = {}) =>
  request('/workspace-contexts', options);

export const getWorkspaceContext = (appId, options = {}) =>
  request(`/workspace-contexts/${encodeURIComponent(appId)}`, options);

export const saveWorkspaceContext = (appId, options = {}) =>
  request(`/workspace-contexts/${encodeURIComponent(appId)}/save`, { method: 'POST', ...options });

export const restoreWorkspaceContext = (appId, options = {}) =>
  request(`/workspace-contexts/${encodeURIComponent(appId)}/restore`, { method: 'POST', ...options });

export const deleteWorkspaceContext = (appId, options = {}) =>
  request(`/workspace-contexts/${encodeURIComponent(appId)}`, { method: 'DELETE', ...options });
