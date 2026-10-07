import { request } from './apiCore.js';

// Mood boards (issue #911) — inspiration/reference canvases that feed the
// Create suite. Boards are db-primary, local-only; items live inline.
// `options` is forwarded to the request helper so callers that own their own
// error UI (useAsyncAction / custom catch) can pass `{ silent: true }`.

export const listMoodBoards = (options) => request('/mood-boards', options);

// `{ id, name }` only — for pickers; skips every board's inline items.
export const listMoodBoardNames = (options) => request('/mood-boards/names', options);

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

// Board analyze runs server-side so it survives navigation: start (or join) the
// job, and read its live state on return. `null` = no run since server start.
export const startMoodBoardAnalyze = (id, { providerId, model, effort } = {}, options = {}) =>
  request(`/mood-boards/${encodeURIComponent(id)}/analyze`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model, effort }),
    ...options,
  });

export const getMoodBoardAnalyze = (id, options = {}) =>
  request(`/mood-boards/${encodeURIComponent(id)}/analyze`, options);

// Distill stored per-item analyses into the board's own composite style prompt
// and persist it on the board (`style`). Resolves to the updated board.
export const composeMoodBoardPrompt = (id, { providerId, model, effort } = {}, options = {}) =>
  request(`/mood-boards/${encodeURIComponent(id)}/compose-prompt`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model, effort }),
    ...options,
  });

// Board → universe style synthesis (#4188 Phase 4). Stateless review step:
// sends the universe's CURRENT style context (styleNotes/influences/locked)
// plus the chosen LLM; resolves to `{ proposed, diff, rationale, llm }`.
// Adoption goes through adoptUniverseStyleGuide (apiUniverseBuilder.js).
export const synthesizeMoodBoardStyle = (id, {
  styleNotes, influences, locked, providerId, model,
} = {}, options = {}) =>
  request(`/mood-boards/${encodeURIComponent(id)}/synthesize-style`, {
    method: 'POST',
    body: JSON.stringify({ styleNotes, influences, locked, providerId, model }),
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

// One-shot import through the signed-in PortOS CDP browser. Resolves
// `{ board, added, found, skipped }`; no credentials or recurring link stored.
export const importMoodBoardPinterest = (id, url, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/pinterest/import`, {
    method: 'POST',
    body: JSON.stringify({ url }),
    ...options,
  });

// One-shot import: paste a public x.com/twitter.com post URL, server pulls its
// attached photos/video into the board. Resolves `{ board, added }`.
export const importMoodBoardXPost = (id, url, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/x-post`, {
    method: 'POST',
    body: JSON.stringify({ url }),
    ...options,
  });

// Download every external image on the board into the local gallery.
// Resolves `{ board, localized, failed }`.
export const localizeMoodBoardMedia = (id, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/localize-media`, { method: 'POST', ...options });

export const composeMoodBoardCollage = (id, body, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/collage`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    ...options,
  });

export const extractMoodBoardItemFrames = (id, itemId, count, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/extract-frames`, {
    method: 'POST',
    body: JSON.stringify({ count }),
    ...options,
  });

// Render a text note into an image (#10531) on the install's default image
// backend. Resolves to `{ item, jobId }` once queued; the note becomes an image
// item when the job completes (`mood-board:item-render` follows it).
export const renderMoodBoardItem = (id, itemId, options) =>
  request(`/mood-boards/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/render`, {
    method: 'POST',
    body: JSON.stringify({}),
    ...options,
  });
