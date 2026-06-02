import { request } from './apiCore.js';

// Unified Story Builder — conductor API. Mirrors apiImporter.js. The server is
// the single source of truth for the step manifest (GET /story-builder/steps),
// so the client stepper doesn't hardcode the order.

export const getStoryBuilderSteps = (options = {}) => request('/story-builder/steps', options);

export const listStorySessions = (options = {}) => request('/story-builder', options);

export const getStorySession = (id, options = {}) => request(`/story-builder/${id}`, options);

export const createStorySession = (payload, options = {}) => request('/story-builder', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options,
});

export const updateStorySession = (id, patch, options = {}) => request(`/story-builder/${id}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});

export const deleteStorySession = (id, options = {}) => request(`/story-builder/${id}`, {
  method: 'DELETE',
  ...options,
});

export const setStoryCurrentStep = (id, stepId, options = {}) =>
  request(`/story-builder/${id}/current-step/${stepId}`, { method: 'POST', ...options });

export const lockStoryStep = (id, stepId, options = {}) =>
  request(`/story-builder/${id}/steps/${stepId}/lock`, { method: 'POST', ...options });

export const unlockStoryStep = (id, stepId, options = {}) =>
  request(`/story-builder/${id}/steps/${stepId}/unlock`, { method: 'POST', ...options });

// generate / refine kick off a background run and return { runId, alreadyRunning,
// sseUrl }. Subscribe to progress via storyStepProgressSseUrl (see
// hooks/useStoryStepProgress.js); the result lands on the stream's `complete`
// frame and the persisted content is read back by refetching the session view.
export const generateStoryStep = (id, stepId, payload = {}, options = {}) =>
  request(`/story-builder/${id}/steps/${stepId}/generate`, {
    method: 'POST',
    body: JSON.stringify(payload),
    ...options,
  });

export const refineStoryStep = (id, stepId, payload = {}, options = {}) =>
  request(`/story-builder/${id}/steps/${stepId}/refine`, {
    method: 'POST',
    body: JSON.stringify(payload),
    ...options,
  });

// Deterministic SSE URL for a step's generate/refine progress stream. Mirrors
// pipelineAutoRunSseUrl — derived from ids, not the kickoff response.
export const storyStepProgressSseUrl = (id, stepId) =>
  `/api/story-builder/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}/progress`;

export const generateStoryIssues = (id, payload = {}, options = {}) =>
  request(`/story-builder/${id}/issues/generate`, {
    method: 'POST',
    body: JSON.stringify(payload),
    ...options,
  });

export const setStoryIssueLock = (id, issueId, locked, options = {}) =>
  request(`/story-builder/${id}/issues/${issueId}/lock`, {
    method: 'POST',
    body: JSON.stringify({ locked }),
    ...options,
  });
