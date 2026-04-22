/**
 * Digital Twin Service — barrel re-export
 *
 * Decomposed from a single god file into focused modules:
 *   digital-twin-constants.js  — ENRICHMENT_CATEGORIES, SCALE_QUESTIONS
 *   digital-twin-helpers.js    — generateId, now, ensureSoulDir, callProviderAI
 *   digital-twin-meta.js       — loadMeta, saveMeta, updateMeta, updateSettings, events
 *   digital-twin-documents.js  — getDocuments, getDocumentById, createDocument, updateDocument, deleteDocument
 *   digital-twin-testing.js    — parseTestSuite, runTests, getTestHistory
 *   digital-twin-enrichment.js — getEnrichmentCategories, generateEnrichmentQuestion, processEnrichmentAnswer, …
 *   digital-twin-export.js     — getExportFormats, exportDigitalTwin, exportSoul
 *   digital-twin-context.js    — getDigitalTwinForPrompt, getSoulForPrompt
 *   digital-twin-analysis.js   — validateCompleteness, detectContradictions, getTraits, calculateConfidence, …
 *   digital-twin-import.js     — analyzeImportedData, saveImportAsDocument, getImportSources, analyzeAssessment
 *   digital-twin-status.js     — getDigitalTwinStatus, getSoulStatus
 */

export { ENRICHMENT_CATEGORIES, SCALE_QUESTIONS } from './digital-twin-constants.js';

export {
  digitalTwinEvents,
  loadMeta,
  saveMeta,
  updateMeta,
  updateSettings
} from './digital-twin-meta.js';

export {
  getDocuments,
  getDocumentById,
  createDocument,
  updateDocument,
  deleteDocument
} from './digital-twin-documents.js';

export {
  parseTestSuite,
  runTests,
  getTestHistory
} from './digital-twin-testing.js';

export {
  getEnrichmentCategories,
  generateEnrichmentQuestion,
  processEnrichmentAnswer,
  getEnrichmentProgress,
  analyzeEnrichmentList,
  saveEnrichmentListDocument,
  getEnrichmentListItems
} from './digital-twin-enrichment.js';

export {
  getExportFormats,
  exportDigitalTwin,
  exportSoul
} from './digital-twin-export.js';

export {
  getDigitalTwinForPrompt,
  getSoulForPrompt
} from './digital-twin-context.js';

export {
  getDigitalTwinStatus,
  getSoulStatus
} from './digital-twin-status.js';

export {
  validateCompleteness,
  detectContradictions,
  generateDynamicTests,
  analyzeWritingSamples,
  getTraits,
  updateTraits,
  analyzeTraits,
  getConfidence,
  calculateConfidence,
  getGapRecommendations
} from './digital-twin-analysis.js';

export {
  analyzeImportedData,
  saveImportAsDocument,
  getImportSources,
  analyzeAssessment
} from './digital-twin-import.js';
