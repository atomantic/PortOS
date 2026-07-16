import { request } from './apiCore.js';

export const listMediaJobs = (filters = {}) => {
  const qs = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v != null && v !== ''),
  ).toString();
  return request(`/media-jobs${qs ? `?${qs}` : ''}`);
};

// `silent` so speculative lookups (e.g. MediaJobThumb hydration for old
// panel/scene jobIds past the queue's 24h archive TTL) don't surface a
// global toast on the routine 404 — the caller's own .catch handles the
// missing-job case as a cache miss.
export const getMediaJob = (id) => request(`/media-jobs/${encodeURIComponent(id)}`, { silent: true });

export const cancelMediaJob = (id, options = {}) => request(`/media-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', ...options });

// Delete a terminal (failed / canceled / completed) job from the archive.
// Live jobs are rejected with 409 — use cancelMediaJob for those.
export const deleteMediaJob = (id, options = {}) => request(`/media-jobs/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });

// Re-enqueue a terminal job (typically `failed`) with the same kind/params/
// owner. Optional `paramOverrides` patches user-facing fields (prompt,
// model, dimensions, etc.) before the re-enqueue; non-listed params inherit
// from the original job. Returns `{ jobId, position, status, retriedFrom }`.
export const retryMediaJob = (id, paramOverrides = null, options = {}) =>
  request(`/media-jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    body: paramOverrides ? JSON.stringify({ params: paramOverrides }) : undefined,
    ...options,
  });

// "Run now" — promote a queued Codex image job past the parallel limit and
// start it immediately alongside the currently-running jobs. Only valid for
// queued codex jobs; the server 400s for GPU jobs (single MLX runtime).
export const runMediaJobNow = (id, options = {}) => request(`/media-jobs/${encodeURIComponent(id)}/run-now`, { method: 'POST', ...options });

// Bulk-cancel every queued (not running) job, optionally scoped to a kind.
// Returns { canceled: <count> }. Running jobs need per-id cancelMediaJob.
export const cancelQueuedMediaJobs = ({ kind } = {}, options = {}) =>
  request(`/media-jobs/cancel-queued${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, { method: 'POST', ...options });

export const refineMediaPrompt = (data) => request('/media-jobs/refine-prompt', {
  method: 'POST',
  body: JSON.stringify(data),
});
