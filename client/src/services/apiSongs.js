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

// AI: draft a brand-new arrangement from a brief (no id, not persisted) →
// { song, llm }. body: { title?, artist?, brief?, mood?, providerId?, model? }.
export const generateSong = (body = {}, options) =>
  request('/songs/generate', { method: 'POST', body: JSON.stringify(body), ...options });

// AI: expand/redraft an existing song → { song, llm }. Pass expandExisting:true
// to fold the stored draft into the prompt. Client merges the result; no save.
export const generateSongFor = (id, body = {}, options) =>
  request(`/songs/${enc(id)}/generate`, { method: 'POST', body: JSON.stringify(body), ...options });

// AI: critique a stored arrangement → { evaluation, llm }. Read-only server-side.
export const evaluateSong = (id, body = {}, options) =>
  request(`/songs/${enc(id)}/evaluate`, { method: 'POST', body: JSON.stringify(body), ...options });
