import { request } from './apiCore.js';

// Per-content-type radio values mirror server/lib/validation.js
// IMPORTER_CONTENT_TYPES; UI strings stay client-side.
export const IMPORTER_CONTENT_TYPES = ['short-story', 'novel', 'screenplay', 'comic-script'];

// Mirror of server/services/importer.js IMPORTER_SOURCE_CHAR_LIMIT so the
// Intake form can warn the user before they hit Analyze.
export const IMPORTER_SOURCE_CHAR_LIMIT = 200_000;

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
