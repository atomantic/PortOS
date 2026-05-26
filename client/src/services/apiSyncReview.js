import { request } from './apiCore.js';

// ---- Duplicate resolution ----
// Same-named-but-different-id Universes / Series that arrive via cross-install
// sync. See server/services/duplicateDetection.js + recordMerge.js.

export const listUniverseDuplicates = (options) =>
  request('/universe-builder/duplicates', options);

export const listSeriesDuplicates = (options) =>
  request('/pipeline/series/duplicates', options);

// Preview returns { survivorId, loserId, preview, conflicts, autoResolved, cascade }.
export const previewUniverseMerge = (body, options) =>
  request('/universe-builder/merge/preview', { method: 'POST', body: JSON.stringify(body), ...options });

export const mergeUniverses = (body, options) =>
  request('/universe-builder/merge', { method: 'POST', body: JSON.stringify(body), ...options });

export const previewSeriesMerge = (body, options) =>
  request('/pipeline/series/merge/preview', { method: 'POST', body: JSON.stringify(body), ...options });

export const mergeSeries = (body, options) =>
  request('/pipeline/series/merge', { method: 'POST', body: JSON.stringify(body), ...options });

// AI-assisted merge: asks the configured AI provider to synthesize a single
// unified text per conflict field, returning { merged: { [field]: string },
// skipped, llm, runId }. The caller applies `merged` as `fieldOverrides` on
// the subsequent merge/preview + merge calls.
export const aiResolveUniverseMerge = (body, options) =>
  request('/universe-builder/merge/ai-resolve', { method: 'POST', body: JSON.stringify(body), ...options });

export const aiResolveSeriesMerge = (body, options) =>
  request('/pipeline/series/merge/ai-resolve', { method: 'POST', body: JSON.stringify(body), ...options });

// ---- Conflict journal ----
// Versions a cross-install LWW overwrite preserved instead of silently losing.
// See server/services/conflictJournalResolver.js.

export const listConflicts = (status, options) =>
  request(`/conflict-journal${status ? `?status=${encodeURIComponent(status)}` : ''}`, options);

export const getConflict = (id, options) =>
  request(`/conflict-journal/${encodeURIComponent(id)}`, options);

// body: { action: 'restore-all'|'merge-fields'|'discard', fields?: string[] }
export const resolveConflict = (id, body, options) =>
  request(`/conflict-journal/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(body), ...options });

export const deleteConflict = (id, options) =>
  request(`/conflict-journal/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
