import { request } from './apiCore.js';

// Mood boards (issue #911) — inspiration/reference canvases that feed the
// Create suite. Boards are db-primary, local-only; items live inline.
// `options` is forwarded to the request helper so callers that own their own
// error UI (useAsyncAction / custom catch) can pass `{ silent: true }`.

export const listMoodBoards = (options) => request('/mood-boards', options);

export const getMoodBoard = (id, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}`, options);

export const createMoodBoard = (data, options) => request('/mood-boards', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});

export const updateMoodBoard = (id, patch, options) => request(`/mood-boards/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});

export const deleteMoodBoard = (id, options) => request(`/mood-boards/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...options,
});

export const addMoodBoardItem = (id, item, options) => request(`/mood-boards/${encodeURIComponent(id)}/items`, {
  method: 'POST',
  body: JSON.stringify(item),
  ...options,
});

export const updateMoodBoardItem = (id, itemId, patch, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    ...options,
  });

export const removeMoodBoardItem = (id, itemId, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    ...options,
  });

// Pinterest importer: link a board to a Pinterest board URL, unlink, and run a
// manual "Sync now" that pulls new pins (download + dedupe) server-side.
export const linkMoodBoardPinterest = (id, url, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/pinterest`, {
    method: 'PUT',
    body: JSON.stringify({ url }),
    ...options,
  });

export const unlinkMoodBoardPinterest = (id, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/pinterest`, {
    method: 'DELETE',
    ...options,
  });

export const syncMoodBoardPinterest = (id, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/pinterest/sync`, {
    method: 'POST',
    ...options,
  });
