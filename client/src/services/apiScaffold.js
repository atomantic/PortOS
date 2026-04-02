import { request } from './apiCore.js';

// Templates & Scaffold
export const getTemplates = () => request('/scaffold/templates');

export const getDirectories = (path = null) => {
  const params = path ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/scaffold/directories${params}`);
};

export const scaffoldApp = (data) => request('/scaffold', {
  method: 'POST',
  body: JSON.stringify(data)
});

export const createFromTemplate = (data) => request('/scaffold/templates/create', {
  method: 'POST',
  body: JSON.stringify(data)
});
