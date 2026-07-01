import { request } from './apiCore.js';

export const listCreativeDirectorProjects = () => request('/creative-director');
// Pass `{ slim: true }` to receive only the fields a polling consumer needs
// (status / per-scene status / finalVideoId / failureReason / updatedAt) —
// drops the `runs[]` history and the full treatment text. Useful
// for 4s-poll surfaces like the Pipeline EpisodeVideoStage.
export const getCreativeDirectorProject = (id, { slim = false } = {}) =>
  request(`/creative-director/${encodeURIComponent(id)}${slim ? '?slim=1' : ''}`);
export const createCreativeDirectorProject = (data) => request('/creative-director', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const updateCreativeDirectorProject = (id, patch) => request(`/creative-director/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deleteCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});
export const startCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}/start`, {
  method: 'POST',
});
export const pauseCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}/pause`, {
  method: 'POST',
});
export const resumeCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}/resume`, {
  method: 'POST',
});
export const createSmokeTestCreativeDirectorProject = () => request('/creative-director/smoke-test', {
  method: 'POST',
});
// Autonomous auto-cast (#1810). `suggest` previews the catalog ingredients the
// director would propose for a free-text brief (no mutation). `apply` derives the
// brief from the project (or accepts an explicit one), appends the fresh
// candidates to the project cast, and links them — returning
// `{ project, added, suggestions }`. `options.silent` defers error toasting to a
// caller that owns its own error UI.
export const suggestCreativeDirectorAutoCast = (brief, { types, limit } = {}, options = {}) =>
  request('/creative-director/auto-cast/suggest', {
    method: 'POST',
    body: JSON.stringify({ brief, ...(types ? { types } : {}), ...(limit ? { limit } : {}) }),
    ...options,
  });
// `compose: true` (#1817) tells the director to autonomously write a treatment +
// scene plan grounded in the freshly-seeded cast — the response carries
// `composing: true` when the server actually kicked the agent off.
// `generateFirstPass: true` (#1818) additionally enqueues a catalog portrait
// render for each newly-cast member lacking one — the response carries a
// `firstPass: { mode, enqueued, skipped }` summary when it ran.
// `generateFirstPassMusicBed: true` (#1928) additionally enqueues a background
// music-bed render for the project itself — the response carries a
// `firstPassMusicBed: { mode, enqueued, jobId?, reason? }` summary when it ran.
export const applyCreativeDirectorAutoCast = (id, { brief, types, limit, compose, generateFirstPass, generateFirstPassMusicBed } = {}, options = {}) =>
  request(`/creative-director/${encodeURIComponent(id)}/auto-cast`, {
    method: 'POST',
    body: JSON.stringify({
      ...(brief ? { brief } : {}),
      ...(types ? { types } : {}),
      ...(limit ? { limit } : {}),
      ...(compose ? { compose: true } : {}),
      ...(generateFirstPass ? { generateFirstPass: true } : {}),
      ...(generateFirstPassMusicBed ? { generateFirstPassMusicBed: true } : {}),
    }),
    ...options,
  });
