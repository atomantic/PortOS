import { request } from './apiCore.js';

// Notes - Vault Management
export const getNotesVaults = () => request('/notes/vaults');
export const detectNotesVaults = () => request('/notes/detect');
export const addNotesVault = (data) => request('/notes/vaults', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateNotesVault = (id, data) => request(`/notes/vaults/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteNotesVault = (id) => request(`/notes/vaults/${id}`, { method: 'DELETE' });

// Notes - Scanning & Reading
export const scanNotesVault = (id, options = {}) => {
  const params = new URLSearchParams();
  if (options.folder) params.set('folder', options.folder);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  return request(`/notes/vaults/${id}/scan?${params}`);
};

export const getNote = (vaultId, path) =>
  request(`/notes/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`);

export const createNote = (vaultId, path, content = '') => request(`/notes/vaults/${vaultId}/note`, {
  method: 'POST',
  body: JSON.stringify({ path, content })
});

export const updateNote = (vaultId, path, content) =>
  request(`/notes/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content })
  });

export const deleteNote = (vaultId, path) =>
  request(`/notes/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`, { method: 'DELETE' });

// Notes - Search & Discovery
export const searchNotes = (vaultId, q, limit) => {
  const params = new URLSearchParams({ q });
  if (limit) params.set('limit', limit);
  return request(`/notes/vaults/${vaultId}/search?${params}`);
};

export const getNotesVaultTags = (vaultId) => request(`/notes/vaults/${vaultId}/tags`);
export const getNotesVaultFolders = (vaultId) => request(`/notes/vaults/${vaultId}/folders`);
export const getNotesVaultGraph = (vaultId) => request(`/notes/vaults/${vaultId}/graph`);
