import { request } from './apiCore.js';

// Rounds workbench API surface (a cappella round writing + learning). Every
// helper takes an optional `options` arg so callers with their own `.catch`
// toast can pass `{ silent: true }` to avoid a double-toast (project
// convention). The id path param is URL-encoded.

const enc = encodeURIComponent;

export const listRounds = (options) => request('/rounds', options);

export const getRound = (id, options) => request(`/rounds/${enc(id)}`, options);

export const createRound = (body = {}, options) =>
  request('/rounds', { method: 'POST', body: JSON.stringify(body), ...options });

export const updateRound = (id, patch, options) =>
  request(`/rounds/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch), ...options });

export const deleteRound = (id, options) =>
  request(`/rounds/${enc(id)}`, { method: 'DELETE', ...options });

// Reset a built-in default song's shipped content (metadata/lyrics/layers/
// references) to the current bundled template → { song }. Preserves the user's
// recordings + learned progress. 400 if the song isn't a built-in default.
export const refreshRoundTemplate = (id, options) =>
  request(`/rounds/${enc(id)}/refresh-template`, { method: 'POST', ...options });

// AI: draft a brand-new arrangement from a brief (no id, not persisted) →
// { song, llm }. body: { title?, artist?, brief?, mood?, providerId?, model? }.
export const generateRound = (body = {}, options) =>
  request('/rounds/generate', { method: 'POST', body: JSON.stringify(body), ...options });

// AI: expand/redraft an existing song → { song, llm }. Pass expandExisting:true
// to fold the stored draft into the prompt. Client merges the result; no save.
export const generateRoundFor = (id, body = {}, options) =>
  request(`/rounds/${enc(id)}/generate`, { method: 'POST', body: JSON.stringify(body), ...options });

// AI: critique a stored arrangement → { evaluation, llm }. Read-only server-side.
export const evaluateRound = (id, body = {}, options) =>
  request(`/rounds/${enc(id)}/evaluate`, { method: 'POST', body: JSON.stringify(body), ...options });

// AI: derive harmony parts (bass, mid/high harmonies) from the song's base
// melody → { scoreParts, llm }. Not persisted server-side; the client merges the
// returned parts into the editor draft and the user Saves. body: { partIds?,
// providerId?, model? } — partIds optionally restricts which harmony parts.
export const deriveRoundParts = (id, body = {}, options) =>
  request(`/rounds/${enc(id)}/derive-parts`, { method: 'POST', body: JSON.stringify(body), ...options });
