/**
 * Manuscript / chat importer.
 */

import { request } from './apiCore.js';

// The intake form needs a source limit before /importer/config resolves.
export {
  CLASSIFY_SOURCE_HEAD_CHARS,
  IMPORTER_CONTENT_TYPES,
  IMPORTER_SOURCE_CHAR_LIMIT as IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK,
} from '../../../server/lib/importerContentTypes.js';

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

// Recovery path when analyze returned `issueSplitFailed` — re-runs ONLY the
// issue split (canon + arc are preserved in the Review panel). Returns
// `{ issueProposals, method }`.
export const retryImporterIssues = (payload, options = {}) => request('/importer/retry-issues', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options,
});
