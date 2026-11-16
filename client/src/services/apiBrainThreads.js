/**
 * API client for Brain threads (tracked-topic open loops): filtered `listThreads`, full records with
 * resolved refs, and thread mutations.
 *
 * Brain threads: the bullet journal's open loops (`/brain/threads`, Brain `threads` entity; a *thread* is a tracked topic, never a message thread): filtered `listThreads`, full record with `resolvedRefs` (`getThread`), create / defaults-free PUT / tombstone delete, ref attach/detach, `attachToThread`, and explicit assigned GitHub ingestion (`syncGithubThreads`).
 */

import { request, queryString } from './apiCore.js';

// Brain Threads API surface (#7664): a *thread* is one tracked topic or commitment with a status, a next action and refs to its records, NOT a message thread (messages/ owns that). Every helper takes an optional `options`
// so a caller with its own error UI can pass `{ silent: true }`. Path params are URL-encoded (an external ref's id is a full URL).
// Server contract (server/routes/brainThreads.js): the list projection omits `notes`; getThread returns the full record with hydrated `resolvedRefs`. PUT is a defaults-free partial; `source`, `externalState` and `closedAt`
// are server-managed and stripped, so never send them. POST /:id/refs is idempotent by (kind, id) and both ref writes return the getThread detail shape, so the open record can be swapped in place.

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
