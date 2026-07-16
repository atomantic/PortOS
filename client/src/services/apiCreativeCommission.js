import { request } from './apiCore.js';

// Client API for the Autonomous Creation Engine (#2657) — standing, recurring
// creative briefs the server fires on a schedule through the Creative Director
// directive pipeline.
//
// `options` lets a caller that owns its own error toast pass `{ silent: true }`
// so request() doesn't also toast — see CLAUDE.md "Custom catch ⇒ silent: true".

export const listCommissions = (options = {}) => request('/creative-commission', options);

export const getCommission = (id, options = {}) =>
  request(`/creative-commission/${encodeURIComponent(id)}`, options);

export const createCommission = (data, options = {}) => request('/creative-commission', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});

export const updateCommission = (id, patch, options = {}) =>
  request(`/creative-commission/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    ...options,
  });

export const deleteCommission = (id, options = {}) =>
  request(`/creative-commission/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...options,
  });

// Rate/annotate a specific run's output (#2657, Phase 2). `feedback` is
// `{ runId, rating: 'up'|'down'|number, note?, tags? }`. Resolves to the full
// updated commission (with the new reaction in `feedback[]`) for reactive state.
export const submitCommissionFeedback = (id, feedback, options = {}) =>
  request(`/creative-commission/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    body: JSON.stringify(feedback),
    ...options,
  });
