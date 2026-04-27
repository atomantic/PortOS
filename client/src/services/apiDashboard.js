import { request } from './apiCore.js';

export const getDashboardLayouts = () => request('/dashboard/layouts');

export const setActiveDashboardLayout = (id) =>
  request('/dashboard/layouts/active', {
    method: 'PUT',
    body: JSON.stringify({ id }),
  });

export const saveDashboardLayout = (id, name, widgets, grid) =>
  request(`/dashboard/layouts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ name, widgets, grid: grid ?? [] }),
  });

export const deleteDashboardLayout = (id) =>
  request(`/dashboard/layouts/${encodeURIComponent(id)}`, { method: 'DELETE' });
