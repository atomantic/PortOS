/**
 * Sidebar sub-nav lists for names and app navigation metadata.
 *
 * Keep these reads independent of the route API modules so the sidebar can
 * load without them. The route modules re-export the same implementations.
 */

import { request } from './apiCore.js';

export const listMusicVideoProjectNames = (options = {}) => request('/music-video/names', options);
export const listPipelineSeriesNames = (options = {}) => request('/pipeline/series/names', options);

// `options` lets a caller that owns its own error toast pass `{ silent: true }`
// so request() doesn't also toast — see AGENTS.md "Custom catch ⇒ silent: true".
export const listUniverseNames = (options = {}) => request('/universe-builder/names', options);

// Apps. The default response remains the PM2-enriched list; `view=nav` and
// `view=probe` are explicit projections for hot name-only and peer callers.
export const getApps = ({ includeQuality = false, view, ...options } = {}) => {
  const query = new URLSearchParams();
  if (includeQuality) query.set('includeQuality', 'true');
  if (view) query.set('view', view);
  const suffix = query.toString() ? `?${query}` : '';
  return request(`/apps${suffix}`, options);
};
