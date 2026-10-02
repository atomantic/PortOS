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

export const preflightCodeAnimationProject = (id, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/preflight`, options);

// Contained production execution (#9388): capability report, operator tool
// paths, and the on-demand adversarial containment check.
export const startCodeAnimationStageRun = (id, input, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/stage-runs`, { method: 'POST', body: JSON.stringify(input ?? {}), ...options });
export const cancelCodeAnimationStageRun = (id, runId, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/stage-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', ...options });
export const getCodeAnimationExecution = (options) => request('/code-animation/execution', options);
export const updateCodeAnimationExecutionTools = (tools, options) => request('/code-animation/execution/tools', { method: 'PUT', body: JSON.stringify(tools), ...options });
export const probeCodeAnimationExecution = (options) => request('/code-animation/execution/probe', { method: 'POST', ...options });

// Explicit production workflows. Preview and final use the stored soundtrack artifact.

export const getCodeAnimationBlenderStarter = options => request('/code-animation/packages/starter/blender', options);

// Production acceptance (#9392): the accepted output with live freshness, side-by-side run
// evidence, explicit promotion of one passing run, and the shorts downstream tools can pick.
export const getCodeAnimationAcceptance = (id, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/acceptance`, options);
export const acceptCodeAnimationOutput = (id, runId, options) => request(`/code-animation/projects/${encodeURIComponent(id)}/accepted-output`, { method: 'POST', body: JSON.stringify({ runId }), ...options });
export const listCodeAnimationAcceptedAssets = ({ cursor, signal, limit = 50 } = {}) =>
  request(`/code-animation/accepted-assets?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal, silent: true });
