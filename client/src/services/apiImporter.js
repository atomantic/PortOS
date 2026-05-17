import { request } from './apiCore.js';

// Per-content-type radio values mirror server/lib/validation.js
// IMPORTER_CONTENT_TYPES; UI strings stay client-side.
export const IMPORTER_CONTENT_TYPES = ['short-story', 'novel', 'screenplay', 'comic-script'];

// Initial fallback for the source-char limit. The arc-role + arc-shape-id
// lists are NOT shadowed client-side — `/importer/config` and the analyze
// response are the source of truth (the prior `IMPORTER_ARC_ROLES_FALLBACK`
// silently drifted from `server/lib/storyArc.js#ARC_ROLES`). Char limit
// stays because the intake form's real-time counter needs a value before
// the GET resolves.
export const IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK = 200_000;
// Mirrors `CLASSIFY_SOURCE_HEAD_CHARS` in server/services/importer.js — the
// classifier only reads the head; the client trims to match so we don't
// ship up to 200K of body that gets discarded.
export const CLASSIFY_SOURCE_HEAD_CHARS = 4_000;

export const getImporterConfig = (options = {}) => request('/importer/config', options);

// Light-tier classifier — sees only the head of the source and returns a
// `{ contentType, confidence, reasoning }` payload so the intake form can
// pre-select the content-type radio. The radio is still user-editable —
// classify is a hint, not a constraint.
export const classifyImport = (payload, options = {}) => request('/importer/classify', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options,
});

export const analyzeImport = (payload, options = {}) => request('/importer/analyze', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options,
});

export const commitImport = (payload, options = {}) => request('/importer/commit', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options,
});
