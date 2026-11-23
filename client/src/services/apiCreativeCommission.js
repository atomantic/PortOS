/**
 * Creative Commissions (Autonomous Creation Engine — standing recurring briefs).
 */

import { request, queryString } from './apiCore.js';

// Client API for the Autonomous Creation Engine (#2657) — standing, recurring
// creative briefs the server fires on a schedule through the Creative Director
// directive pipeline.
//
// `options` lets a caller that owns its own error toast pass `{ silent: true }`
// so request() doesn't also toast — see AGENTS.md "Custom catch ⇒ silent: true".

// `page` ({ limit, offset }, limit <= 500) opts into the bounded `{ items, total, limit, offset }` envelope.
export const listCommissions = (options = {}, page) => request(`/creative-commission${queryString(page)}`, options);

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

// Fire a commission immediately, outside its schedule ("Run Now" — the test
// button). Resolves to the fire outcome `{ status, reason?, error?, run,
// projectId?, commission }` — `commission` is the refreshed record (new run
// appended) for reactive state.
export const runCommissionNow = (id, options = {}) =>
  request(`/creative-commission/${encodeURIComponent(id)}/run`, {
    method: 'POST',
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
