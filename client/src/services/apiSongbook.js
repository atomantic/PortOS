/**
 * API client for the SongBook repertoire tracker: song CRUD, stage patch, `practiceSong` graded
 * practice logging, URL import drafts and attachments.
 *
 * `/songbook` (Brain `songs` entity): song CRUD + stage PATCH, `practiceSong(id, quality)` (logs a 0..5-graded run; the server owns the SM-2 advance and the resulting `stage`/`practice`), URL import draft, and attachments (base64 upload, present-flag list, raw serve URL via `songAttachmentUrl`).
 */

import { request } from './apiCore.js';

// SongBook API surface (Brain repertoire tracker: guitar tabs / chord sheets / sheet music at /songbook). Every helper takes an optional `options` so callers with their own `.catch` toast can pass `{ silent: true }`. Path params are URL-encoded.
// Server contract (server/routes/brainSongbook.js): POST / and POST /:id/attachments return 201 (the record / `{ attachment }`). PATCH is a defaults-free partial BUT a nested `content` object fills inner defaults, so always send the WHOLE
// content ({ format, text }), never `{ content: { text } }` alone (format would reset to 'tab'); never send `attachments` (server-managed). DELETE /:id/attachments/:filename returns `{ success, filename, attachments }` (the updated meta list).
// GET /:id/attachments entries carry `present: boolean` (bytes exist on this machine); serving an absent file 404s with code NOT_ON_THIS_MACHINE.

const enc = encodeURIComponent;

export const listSongs = (options) => request('/brain/songbook', options);

export const getSong = (id, options) => request(`/brain/songbook/${enc(id)}`, options);

export const createSong = (body = {}, options) =>
  request('/brain/songbook', { method: 'POST', body: JSON.stringify(body), ...options });

// Defaults-free partial PATCH — also the stage chip-flip path
// (`updateSong(id, { stage })`).
export const updateSong = (id, patch, options) =>
  request(`/brain/songbook/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch), ...options });

export const deleteSong = (id, options) =>
  request(`/brain/songbook/${enc(id)}`, { method: 'DELETE', ...options });

// Log one practice run, graded 0..5 (`SONG_PRACTICE_RATINGS` in components/songbook/constants.js) → the updated song. The server owns the SM-2 advance; a client-supplied `practice` object is stripped (#4102).
export const practiceSong = (id, quality, options) =>
  request(`/brain/songbook/${enc(id)}/practice`, { method: 'POST', body: JSON.stringify({ quality }), ...options });

// Fetch + extract a draft from a tab/chord-sheet URL → { draft: { title, artist, content: { format, text }, sourceUrl } }; nothing is stored. Errors: 400 UNSAFE_URL, 502 SONG_IMPORT_FETCH_FAILED, 422 SONG_IMPORT_EMPTY.
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
