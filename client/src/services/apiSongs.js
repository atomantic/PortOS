import { request } from './apiCore.js';

// Songs workbench API surface (a cappella song writing + learning). Every
// helper takes an optional `options` arg so callers with their own `.catch`
// toast can pass `{ silent: true }` to avoid a double-toast (project
// convention). The id path param is URL-encoded.

const enc = encodeURIComponent;

export const listSongs = (options) => request('/songs', options);

export const getSong = (id, options) => request(`/songs/${enc(id)}`, options);

export const createSong = (body = {}, options) =>
  request('/songs', { method: 'POST', body: JSON.stringify(body), ...options });

export const updateSong = (id, patch, options) =>
  request(`/songs/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch), ...options });

export const deleteSong = (id, options) =>
  request(`/songs/${enc(id)}`, { method: 'DELETE', ...options });
