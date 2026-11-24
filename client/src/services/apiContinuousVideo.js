/**
 * Continuous-video episode generation: client-side-callable lint preview of a scene draft,
 * queue-episode submit, and the SSE progress-events URL.
 */

import { request } from './apiCore.js';

// Continuous-video episode generation (#6227) — submit a multi-scene script +
// bible for chained clip generation, or lint a draft before submitting it
// (Episode Composer, #6228). `options` lets a caller suppress request()'s
// auto-toast with `{ silent: true }` when it owns its own error UI.

// Compose the scenes into clips and lint them WITHOUT submitting anything.
// Resolves to `{ clips, lint: { pass, results: [{ index, pass, reasons }] } }`.
export const lintContinuousVideoEpisode = (body, options = {}) => request('/continuous-video/lint', {
  method: 'POST', body: JSON.stringify(body), silent: true, ...options,
});

// Queue the episode for generation. Resolves to `{ jobId, generationId, status }`.
// A 422 VIDEO_PROMPT_LINT_FAILED means the server-side lint rejected a clip —
// the caller should already have surfaced this via lintContinuousVideoEpisode.
export const generateContinuousVideoEpisode = (body, options = {}) => request('/continuous-video', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// EventSource URL for an episode job's progress stream (consumed by useSseProgress).
export const continuousVideoEpisodeEventsUrl = (jobId) =>
  `/api/continuous-video/${encodeURIComponent(jobId)}/events`;

// Discover currently running continuous-video episodes so EpisodeComposer can
// reattach after a drawer close/reopen or page reload.
export const getActiveContinuousVideoEpisodes = (options = {}) => request('/continuous-video/active', {
  silent: true, ...options,
});

// Request cancellation of an active continuous-video episode.
export const cancelContinuousVideoEpisode = (jobId, options = {}) => request(`/continuous-video/${encodeURIComponent(jobId)}/cancel`, {
  method: 'POST', ...options,
});
