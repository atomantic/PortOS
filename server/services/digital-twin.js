/**
 * Digital Twin Service — barrel re-export
 *
 * Decomposed from a single god file into focused modules:
 *   digital-twin-constants.js  — ENRICHMENT_CATEGORIES, SCALE_QUESTIONS
 *   digital-twin-helpers.js    — generateId, now, ensureSoulDir, callProviderAI
 *   digital-twin-meta.js       — loadMeta, saveMeta, updateMeta, updateSettings, events
 *   digital-twin-documents.js  — getDocuments, getDocumentById, createDocument, updateDocument, deleteDocument
 *   digital-twin-testing.js    — parseTestSuite, runTests, getTestHistory
 *   digital-twin-values-testing.js — parseValuesAlignmentSuite, runValuesAlignmentTests, getValuesAlignmentHistory
 *   digital-twin-adversarial-testing.js — parseAdversarialSuite, runAdversarialTests, getAdversarialTestHistory
 *   digital-twin-multi-turn-testing.js — parseMultiTurnSuite, runMultiTurnTests, getMultiTurnTestHistory
 *   digital-twin-personas.js   — getPersonas, createPersona, updatePersona, deletePersona, setActivePersona, getActivePersona
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
  parseValuesAlignmentSuite,
  runValuesAlignmentTests,
  getValuesAlignmentHistory
} from './digital-twin-values-testing.js';

export {
  parseAdversarialSuite,
  runAdversarialTests,
  getAdversarialTestHistory
} from './digital-twin-adversarial-testing.js';

export {
  parseMultiTurnSuite,
  runMultiTurnTests,
  getMultiTurnTestHistory
} from './digital-twin-multi-turn-testing.js';

export {
  getPersonas,
  getPersonaById,
  createPersona,
  updatePersona,
  deletePersona,
  setActivePersona,
  getActivePersona
} from './digital-twin-personas.js';

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
  buildAvatarBio,
  polishAvatarBio,
  AVATAR_BIO_LENGTHS,
  DEFAULT_AVATAR_BIO_LENGTH
} from './digital-twin-avatar-bio.js';

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
  compareSpokenWrittenStyle,
  parseStyleComparison
} from './digital-twin-style-comparison.js';

export {
  analyzeIdentityImage,
  saveIdentityImageDocument,
  parseIdentityImage
} from './digital-twin-image-identity.js';

export {
  analyzeImportedData,
  saveImportAsDocument,
  getImportSources,
  analyzeAssessment
} from './digital-twin-import.js';
