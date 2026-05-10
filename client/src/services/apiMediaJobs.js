import { request } from './apiCore.js';

export const listMediaJobs = (filters = {}) => {
  const qs = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v != null && v !== ''),
  ).toString();
  return request(`/media-jobs${qs ? `?${qs}` : ''}`);
};

export const getMediaJob = (id) => request(`/media-jobs/${encodeURIComponent(id)}`);

export const cancelMediaJob = (id) => request(`/media-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

// Bulk-cancel every queued (not running) job, optionally scoped to a kind.
// Returns { canceled: <count> }. Running jobs need per-id cancelMediaJob.
export const cancelQueuedMediaJobs = ({ kind } = {}) =>
  request(`/media-jobs/cancel-queued${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, { method: 'POST' });
