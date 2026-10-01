import { request } from './apiCore.js';

export const listCodeAnimationProjects = ({ cursor, signal, limit = 50 } = {}) =>
  request(`/code-animation/projects?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal, silent: true });
export const createCodeAnimationProject = (input, options) => request('/code-animation/projects', { method: 'POST', body: JSON.stringify(input), ...options });
export const getCodeAnimationProject = (id, options) => request(`/code-animation/projects/${encodeURIComponent(id)}`, options);
export const updateCodeAnimationProject = (id, input, options) => request(`/code-animation/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input), ...options });
export const importCodeAnimationPackage = (id, pkg, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify(pkg), ...options });
export const acceptCodeAnimationSource = (id, revisionId, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/accept`, { method: 'POST', body: JSON.stringify({ revisionId }), ...options });
export const getCodeAnimationProjectBrief = (id, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/brief`, options);
export const getCodeAnimationRevisionPackage = (id, revisionId, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/package`, options);
export const listCodeAnimationProjectHistory = (id, { cursor, signal, limit = 50 } = {}) =>
  request(`/code-animation/projects/${encodeURIComponent(id)}/history?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal, silent: true });

// Code Animation — build an LLM prompt for a procedurally coded animation film
// styled by a universe (plus mood board, references, audio), and optionally run
// it on a provider to get the film's HTML. `options` is forwarded to the
// request helper so callers owning their error UI can pass `{ silent: true }`.

export const getCodeAnimationOptions = (options) => request('/code-animation/options', options);

// Ask a model to WRITE the brief from the chosen universe's bible and canon cast.
export const generateCodeAnimationBrief = (input, options) => request('/code-animation/brief', {
  method: 'POST',
  body: JSON.stringify(input),
  ...options,
});

export const buildCodeAnimationPrompt = (brief, options) => request('/code-animation/prompt', {
  method: 'POST',
  body: JSON.stringify(brief),
  ...options,
});

export const startCodeAnimationGeneration = (brief, options) => request('/code-animation/generate', {
  method: 'POST',
  body: JSON.stringify(brief),
  ...options,
});

export const listCodeAnimationJobPage = ({ cursor, signal, limit = 50 } = {}) =>
  request(`/code-animation/jobs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    { signal, silent: true });

export const getCodeAnimationJob = (id, options) =>
  request(`/code-animation/generate/${encodeURIComponent(id)}`, options);

export const getCodeAnimationPackage = (id, options) =>
  request(`/code-animation/${encodeURIComponent(id)}/package`, options);

// Queue a frame-exact MP4 export; returns { jobId, notes }. Progress streams
// from /api/html-composition/:jobId/events.
export const exportCodeAnimation = (id, options) => request(`/code-animation/${encodeURIComponent(id)}/export`, {
  method: 'POST',
  ...options,
});

// Cancel a queued/running export; the renderer removes its partial output.
export const cancelCodeAnimationExport = (exportJobId, options) => request(`/html-composition/${encodeURIComponent(exportJobId)}/cancel`, {
  method: 'POST',
  ...options,
});
