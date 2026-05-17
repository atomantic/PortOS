import { request } from './apiCore.js';

// Per-content-type radio values mirror server/lib/validation.js
// IMPORTER_CONTENT_TYPES; UI strings stay client-side.
export const IMPORTER_CONTENT_TYPES = ['short-story', 'novel', 'screenplay', 'comic-script'];

// Initial fallback for the source-char limit + arc-role list. These are the
// values shipped with this client; on mount the Importer page fetches
// `/importer/config` and overwrites them with whatever the server reports —
// so a server-side bump (or a chunked-extraction follow-up that lifts the
// cap) automatically reaches the UI without a client redeploy. Treat these
// as last-resort defaults if the config call fails or is in flight.
export const IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK = 200_000;
export const IMPORTER_ARC_ROLES_FALLBACK = ['pilot', 'complication', 'midpoint', 'b-plot', 'all-is-lost', 'finale'];

export const getImporterConfig = (options = {}) => request('/importer/config', options);

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
