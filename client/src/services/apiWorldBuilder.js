import { request } from './apiCore.js';

export const WORLD_CATEGORIES = ['landscapes', 'environments', 'characters', 'structures', 'vehicles'];

export const listWorlds = () => request('/world-builder');
export const getWorld = (id) => request(`/world-builder/${encodeURIComponent(id)}`);

export const createWorld = (data) => request('/world-builder', {
  method: 'POST',
  body: JSON.stringify(data),
});

export const updateWorld = (id, patch) => request(`/world-builder/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});

export const deleteWorld = (id) => request(`/world-builder/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});

export const expandWorld = ({ starterPrompt, providerId, model } = {}) => request('/world-builder/expand', {
  method: 'POST',
  body: JSON.stringify({ starterPrompt, providerId, model }),
});

export const renderWorld = (id, options) => request(`/world-builder/${encodeURIComponent(id)}/render`, {
  method: 'POST',
  body: JSON.stringify(options || {}),
});

export const listWorldRuns = (id) => request(`/world-builder/${encodeURIComponent(id)}/runs`);
