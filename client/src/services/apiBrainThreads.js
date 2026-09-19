import { request, queryString } from './apiCore.js';

// Brain Threads API surface — the bullet journal's open loops at
// /brain/threads (#7664). A *thread* here is one tracked topic or commitment
// with a status, a next action and refs to the records that belong to it — NOT
// a message thread (messages/ owns that sense of the word).
//
// Every helper takes an optional `options` arg so a caller with its own error
// UI can pass `{ silent: true }` (project convention). Path params are
// URL-encoded — an external ref's id is a full URL.
//
// Server contract notes (server/routes/brainThreads.js):
// - The list projection omits `notes`; the full record (with `resolvedRefs`,
//   hydrated for display) comes from getThread.
// - PUT is a defaults-free partial. `source`, `externalState` and `closedAt`
//   are server-managed and stripped from a client write — never send them.
// - POST /:id/refs is idempotent by (kind, id); both ref writes return the
//   same detail shape as getThread (with `resolvedRefs`), so the open record
//   can be swapped in place.

const enc = encodeURIComponent;

// Filters: status (one, or a comma list for the working set), priority, tag,
// pinned ('true'/'false'), refKind, q — plus `limit`/`offset` to paginate, which
// switches the response to `{ threads, total, limit, offset }`.
export const listThreads = (filters = {}, options) =>
  request(`/brain/threads${queryString(filters)}`, options);

export const getThread = (id, options) => request(`/brain/threads/${enc(id)}`, options);

export const createThread = (body = {}, options) =>
  request('/brain/threads', { method: 'POST', body: JSON.stringify(body), ...options });

export const updateThread = (id, patch, options) =>
  request(`/brain/threads/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch), ...options });

export const deleteThread = (id, options) =>
  request(`/brain/threads/${enc(id)}`, { method: 'DELETE', ...options });

// ref: { kind, id, label? } → the updated thread with `resolvedRefs` (201).
export const addThreadRef = (id, ref, options) =>
  request(`/brain/threads/${enc(id)}/refs`, { method: 'POST', body: JSON.stringify(ref), ...options });

export const removeThreadRef = (id, kind, refId, options) =>
  request(`/brain/threads/${enc(id)}/refs/${enc(kind)}/${enc(refId)}`, { method: 'DELETE', ...options });

// POST /api/brain/threads/attach — `{ ref, threadId?, title? }` → `{ thread, created }` (200 / 201).
export const attachToThread = (body = {}, options) =>
  request('/brain/threads/attach', { method: 'POST', body: JSON.stringify(body), ...options });

// Explicit, on-demand GitHub discovery; no background polling is enabled.
export const syncGithubThreads = (body, options) =>
  request('/brain/threads/sync', { method: 'POST', body: JSON.stringify(body), ...options });
