import { request } from './apiCore.js';
import { fetchByIds } from './apiBatch.js';

export const listCreativeDirectorProjects = (options = {}) => request('/creative-director', options);
// Pass `{ slim: true }` to receive only the fields a polling consumer needs
// (status / per-scene status / finalVideoId / failureReason / updatedAt) —
// drops the `runs[]` history and the full treatment text. Useful
// for 4s-poll surfaces like the Pipeline EpisodeVideoStage.
export const getCreativeDirectorProject = (id, { slim = false } = {}) =>
  request(`/creative-director/${encodeURIComponent(id)}${slim ? '?slim=1' : ''}`);
// Batch fetch projects by id (#4148) — the `ids` filter rides the normal list
// endpoint, so the response is the same full, non-slim project shape previews
// compute from. Used by surfaces that reference a known handful of projects
// (the Creative Commission detail page's render history) instead of pulling
// every project on the install. Server-side cap is 100 ids per batch.
export const getCreativeDirectorProjectsByIds = (ids = [], options = {}) =>
  fetchByIds('/creative-director', ids, options);
export const createCreativeDirectorProject = (data, options = {}) => request('/creative-director', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});
export const updateCreativeDirectorProject = (id, patch, options = {}) => request(`/creative-director/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});
export const deleteCreativeDirectorProject = (id, options = {}) => request(`/creative-director/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...options,
});
export const startCreativeDirectorProject = (id, options = {}) => request(`/creative-director/${encodeURIComponent(id)}/start`, {
  method: 'POST',
  ...options,
});
export const pauseCreativeDirectorProject = (id, options = {}) => request(`/creative-director/${encodeURIComponent(id)}/pause`, {
  method: 'POST',
  ...options,
});
// The hard counterpart to pause: kills the live agent, retires the CoS tasks
// behind the in-flight runs (the orphan sweep respawns them otherwise), settles
// the runs, and cancels the queued renders. Resolves to the teardown counts.
export const stopCreativeDirectorProject = (id, options = {}) => request(`/creative-director/${encodeURIComponent(id)}/stop`, {
  method: 'POST',
  ...options,
});
export const resumeCreativeDirectorProject = (id, options = {}) => request(`/creative-director/${encodeURIComponent(id)}/resume`, {
  method: 'POST',
  ...options,
});
export const createSmokeTestCreativeDirectorProject = (options = {}) => request('/creative-director/smoke-test', {
  method: 'POST',
  ...options,
});
// Creative tool catalog (CDO Phase 4, #2186) — `{ tools: [{ id, description,
// costClass, longRunning, destructive }], mode, budget }`. The Plan board
// hydrates per-step cost-class badges + approval affordances from it; `mode`
// drives the dry-run banner. `options.silent` defers error toasting to a caller
// that owns its own error UI.
export const getCreativeToolCatalog = (options = {}) => request('/creative-director/tools', options);
// Attach/replace a directive on an existing project ("convert to directive").
// Clears any prior plan so the planner re-derives one; returns the updated
// project for reactive state swap.
export const setCreativeDirectorDirective = (id, directive, options = {}) => request(`/creative-director/${encodeURIComponent(id)}/directive`, {
  method: 'POST',
  body: JSON.stringify(directive),
  ...options,
});
// Request a fresh plan (drops the current plan, re-runs the planner). Blocked-step
// triage "re-plan" action.
export const replanCreativeDirectorProject = (id, options = {}) => request(`/creative-director/${encodeURIComponent(id)}/replan`, {
  method: 'POST',
  ...options,
});
// Blocked-step triage: `skip` a step or `retry` (reset a blocked/failed step to
// pending — also the "approve" affordance for a gate-blocked step). Returns the
// updated project. `options.silent` defers error toasting.
export const updateCreativeDirectorPlanStep = (id, stepId, action, options = {}) =>
  request(`/creative-director/${encodeURIComponent(id)}/plan/step/${encodeURIComponent(stepId)}`, {
    method: 'POST',
    body: JSON.stringify({ action }),
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
