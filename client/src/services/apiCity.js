import { request } from './apiCore.js';

// CyberCity snapshots — historical city-state series for the timeline scrubber.
// The capture pipeline (issue #877) records frames server-side; these read them.

// GET /api/city/snapshots — the recorded series, oldest-first.
// options: { since?: ISO string, limit?: number, silent?: boolean }
export const getCitySnapshots = (options = {}) => {
  const { since, limit, ...rest } = options;
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit != null) params.set('limit', limit);
  const qs = params.toString();
  return request(`/city/snapshots${qs ? `?${qs}` : ''}`, rest);
};

// GET /api/city/snapshots/config — effective capture config + next run time.
export const getCitySnapshotConfig = (options = {}) =>
  request('/city/snapshots/config', options);

// POST /api/city/snapshots/capture — capture a frame on demand.
export const captureCitySnapshot = (options = {}) =>
  request('/city/snapshots/capture', { method: 'POST', ...options });
