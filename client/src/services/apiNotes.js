import { request } from './apiCore.js';

// Notes - Vault Management
export const getNotesVaults = (options) => request('/notes/vaults', options);
export const detectNotesVaults = (options) => request('/notes/detect', options);
export const addNotesVault = (data, options = {}) => request('/notes/vaults', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});

// Notes - Scanning & Reading
export const scanNotesVault = (id, { folder, limit, offset, ...requestOptions } = {}) => {
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  return request(`/notes/vaults/${id}/scan?${params}`, requestOptions);
};

export const getNote = (vaultId, path, options) =>
  request(`/notes/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`, options);

export const createNote = (vaultId, path, content = '', options = {}) => request(`/notes/vaults/${vaultId}/note`, {
  method: 'POST',
  body: JSON.stringify({ path, content }),
  ...options
});

// `force` bypasses the server's iCloud dataless screen (#3717). Only ever pass
// it from an explicit user click on the "Save anyway" override — never as an
// automatic retry.
export const updateNote = (vaultId, path, content, { force = false, ...options } = {}) =>
  request(`/notes/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content, force }),
    ...options
  });

export const deleteNote = (vaultId, path, options = {}) =>
  request(`/notes/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`, { method: 'DELETE', ...options });

// Notes - Search & Discovery
export const searchNotes = (vaultId, q, limit, options = {}) => {
  const params = new URLSearchParams({ q });
  if (limit) params.set('limit', limit);
  return request(`/notes/vaults/${vaultId}/search?${params}`, options);
};

export const getNotesVaultTags = (vaultId, options) => request(`/notes/vaults/${vaultId}/tags`, options);
export const getNotesVaultFolders = (vaultId, options) => request(`/notes/vaults/${vaultId}/folders`, options);
export const getNotesVaultGraph = (vaultId, options) => request(`/notes/vaults/${vaultId}/graph`, options);
