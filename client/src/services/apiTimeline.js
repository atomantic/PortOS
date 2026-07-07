import { request } from './apiCore.js';

// Human-activity timeline (#2150). Day view + filtered event list.

export const getTimelineDay = (options = {}) => {
  const params = new URLSearchParams();
  if (options.date) params.set('date', options.date);
  const qs = params.toString();
  return request(`/timeline/day${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

export const getTimelineEvents = (options = {}) => {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.source) params.set('source', options.source);
  if (options.kind) params.set('kind', options.kind);
  if (options.personId) params.set('personId', options.personId);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request(`/timeline/events${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

// Bulk-backfill importer (#2160). Upload a Spotify extended-history export (ZIP
// or a single history JSON). `preview: true` returns parse-only counts + a
// summary without writing; a real import is idempotent so re-imports are safe.
// request() detects the FormData body and lets the browser set the boundary.
export const importSpotifyHistory = (file, { preview = false, ...options } = {}) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('preview', preview ? 'true' : 'false');
  return request('/timeline/import/spotify', { method: 'POST', body: formData, ...options });
};
