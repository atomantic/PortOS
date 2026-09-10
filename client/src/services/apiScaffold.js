import { request } from './apiCore.js';

// Templates & Scaffold
export const getTemplates = () => request('/scaffold/templates');

export const getDirectories = (path = null, { includeFiles = false } = {}) => {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (includeFiles) params.set('includeFiles', 'true');
  return request(`/scaffold/directories${params.size ? `?${params}` : ''}`);
};

export const createFromTemplate = (data) => request('/scaffold/templates/create', {
  method: 'POST',
  body: JSON.stringify(data)
});
