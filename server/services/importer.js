/** Compatibility exports for manuscript import analysis, comic splitting, and commit. */

export { importerEvents } from './importerEvents.js';
export { IMPORTER_PROSE_EXCERPT_MAX } from '../lib/creativeDirectorValidation.js';
export { CLASSIFY_SOURCE_HEAD_CHARS, IMPORTER_SOURCE_CHAR_LIMIT } from '../lib/importerContentTypes.js';
export {
  ERR_VALIDATION,
  ERR_LOCKED,
  ERR_PARTIAL_COMMIT_ISSUES,
  ERR_IMPORT_IN_PROGRESS,
} from './importer/importerErrors.js';
export {
  ANALYZE_STAGES,
  ANALYZE_STAGE_TIMEOUT_MS,
  findUniverseByName,
  findSeriesByName,
  classifyImportContent,
  analyzeImport,
  retryIssueSplit,
} from './importer/importerAnalyze.js';
export { reformatSeededExcerpts, mergeSeasons, commitImport } from './importer/importerCommit.js';
export { splitComicScriptIssues } from './importer/importerComicSplit.js';
