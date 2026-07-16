import { request } from './apiCore.js';

// SongBook API surface (Brain repertoire tracker — guitar tabs / chord sheets /
// sheet music at /songbook). Every helper takes an optional `options` arg so
// callers with their own `.catch` toast can pass `{ silent: true }` to avoid a
// double-toast (project convention). Path params are URL-encoded.
//
// Server contract notes (server/routes/brainSongbook.js):
// - POST / and POST /:id/attachments return 201 with the created record /
//   `{ attachment }` in the body.
// - PUT is a defaults-free partial, BUT a nested `content` object fills inner
//   defaults — callers must always send the WHOLE content object
//   ({ format, text }), never `{ content: { text } }` alone (format would
//   reset to 'tab'). Never send `attachments` (server-managed; stripped).
// - DELETE /:id/attachments/:filename returns
//   `{ success, filename, attachments }` — `attachments` is the updated meta
//   list, usable directly for reactive state.
// - GET /:id/attachments entries carry `present: boolean` (bytes exist on this
//   machine); serving an absent file 404s with code NOT_ON_THIS_MACHINE.

const enc = encodeURIComponent;

export const listSongs = (options) => request('/brain/songbook', options);

export const getSong = (id, options) => request(`/brain/songbook/${enc(id)}`, options);

export const createSong = (body = {}, options) =>
  request('/brain/songbook', { method: 'POST', body: JSON.stringify(body), ...options });

export const updateSong = (id, patch, options) =>
  request(`/brain/songbook/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch), ...options });

// Cheap chip-flip path — PATCH only the learning stage.
export const patchSongStage = (id, stage, options) =>
  request(`/brain/songbook/${enc(id)}/stage`, { method: 'PATCH', body: JSON.stringify({ stage }), ...options });

export const deleteSong = (id, options) =>
  request(`/brain/songbook/${enc(id)}`, { method: 'DELETE', ...options });

// Fetch + extract a draft from a tab/chord-sheet URL → { draft: { title,
// artist, content: { format, text }, sourceUrl } }. Nothing is stored — the
// user reviews and saves explicitly. Error codes: 400 UNSAFE_URL,
// 502 SONG_IMPORT_FETCH_FAILED, 422 SONG_IMPORT_EMPTY.
export const importSongFromUrl = (url, options) =>
  request('/brain/songbook/import/url', { method: 'POST', body: JSON.stringify({ url }), ...options });

// → [{ filename, label, mime, size, sha256, present }] (present = bytes local)
export const listSongAttachments = (id, options) =>
  request(`/brain/songbook/${enc(id)}/attachments`, options);

// body: { filename, data (base64), label? } → { attachment } (201)
export const uploadSongAttachment = (id, body, options) =>
  request(`/brain/songbook/${enc(id)}/attachments`, { method: 'POST', body: JSON.stringify(body), ...options });

// → { success, filename, attachments } — attachments is the updated meta list.
export const deleteSongAttachment = (id, filename, options) =>
  request(`/brain/songbook/${enc(id)}/attachments/${enc(filename)}`, { method: 'DELETE', ...options });

// Raw URL for opening/serving an attachment's bytes (href/src, not fetch).
export const songAttachmentUrl = (id, filename) =>
  `/api/brain/songbook/${enc(id)}/attachments/${enc(filename)}`;
