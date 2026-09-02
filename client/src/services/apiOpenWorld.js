import { request } from './apiCore.js';

// OpenWorld snapshots — historical world-state series for the timeline scrubber.
// The capture pipeline (issue #877) records frames server-side; these read them.

// GET /api/openworld/snapshots — the recorded series, oldest-first.
// options: { since?: ISO string, limit?: number, silent?: boolean }
export const getOpenWorldSnapshots = (options = {}) => {
  const { since, limit, ...rest } = options;
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit != null) params.set('limit', limit);
  const qs = params.toString();
  return request(`/openworld/snapshots${qs ? `?${qs}` : ''}`, rest);
};

// GET /api/openworld/introspection — DB tables + data/ domain sizes for the Data
// Harbor district. Server-cached; `db: null` means the database is unreachable.
export const getOpenWorldIntrospection = (options = {}) =>
  request('/openworld/introspection', options);
