/**
 * Digital Twin API Routes
 *
 * Handles all HTTP endpoints for the Digital Twin feature:
 * - Document CRUD
 * - Behavioral testing
 * - Enrichment questionnaire
 * - Export
 * - Settings
 */

import { Router } from 'express';
import * as digitalTwinService from '../services/digital-twin.js';
import * as tasteService from '../services/taste-questionnaire.js';
import * as feedbackService from '../services/feedbackLoop.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  createDocumentInputSchema,
  updateDocumentInputSchema,
  runTestsInputSchema,
  runMultiTestsInputSchema,
  enrichmentQuestionInputSchema,
  enrichmentAnswerInputSchema,
  exportInputSchema,
  settingsUpdateInputSchema,
  testHistoryQuerySchema,
  contradictionInputSchema,
  generateTestsInputSchema,
  writingAnalysisInputSchema,
  spokenWrittenStyleInputSchema,
  identityImageInputSchema,
  identityImageSaveInputSchema,
  analyzeListInputSchema,
  saveListDocumentInputSchema,
  getListItemsInputSchema,
  analyzeTraitsInputSchema,
  updateTraitsInputSchema,
  calculateConfidenceInputSchema,
  importDataInputSchema,
  analyzeAssessmentInputSchema,
  tasteAnswerInputSchema,
  tasteSummaryInputSchema,
  tasteSectionEnum,
  tastePersonalizedQuestionInputSchema,
  feedbackInputSchema,
  createSnapshotInputSchema,
  compareSnapshotsInputSchema,
  createPersonaInputSchema,
  updatePersonaInputSchema,
  setActivePersonaInputSchema,
  twinEvidenceRecomputeInputSchema,
  twinEvidenceInterpretInputSchema
} from '../lib/digitalTwinValidation.js';
import * as twinEnrichment from '../services/twinEnrichment.js';
import * as timeCapsuleService from '../services/timeCapsule.js';
import { UUID_RE } from '../lib/fileUtils.js';
import { z } from 'zod';

const importSaveSchema = z.object({
  source: z.string().min(1),
  suggestedDoc: z.object({
    filename: z.string().min(1),
    content: z.string().min(1),
    title: z.string().optional(),
    category: z.string().optional(),
  }),
});

const router = Router();

/**
 * Assert a persona id (when supplied) resolves to a stored persona, throwing
 * 404 otherwise. A test run with a stale/deleted personaId would otherwise
 * silently fall back to the base twin, mislabeling the result; this makes the
 * contract explicit — mirroring the same guard on PUT /personas/active.
 */
async function assertPersonaExists(personaId) {
  if (personaId && !(await digitalTwinService.getPersonaById(personaId))) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
}

// =============================================================================
// STATUS & SUMMARY
// =============================================================================

/**
 * GET /api/digital-twin
 * Get digital twin status summary
 */
router.get('/', asyncHandler(async (req, res) => {
  const status = await digitalTwinService.getDigitalTwinStatus();
  res.json(status);
}));

// =============================================================================
// DOCUMENTS
// =============================================================================

/**
 * GET /api/digital-twin/documents
 * List all digital twin documents
 */
router.get('/documents', asyncHandler(async (req, res) => {
  const documents = await digitalTwinService.getDocuments();
  res.json(documents);
}));

/**
 * GET /api/digital-twin/documents/:id
 * Get a single document with content
 */
router.get('/documents/:id', asyncHandler(async (req, res) => {
  const document = await digitalTwinService.getDocumentById(req.params.id);
  if (!document) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(document);
}));

/**
 * POST /api/digital-twin/documents
 * Create a new document
 */
router.post('/documents', asyncHandler(async (req, res) => {
  const data = validateRequest(createDocumentInputSchema, req.body);
  const document = await digitalTwinService.createDocument(data);
  res.status(201).json(document);
}));

/**
 * PUT /api/digital-twin/documents/:id
 * Update a document
 */
router.put('/documents/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(updateDocumentInputSchema, req.body);
  const document = await digitalTwinService.updateDocument(req.params.id, data);
  if (!document) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(document);
}));

/**
 * DELETE /api/digital-twin/documents/:id
 * Delete a document
 */
router.delete('/documents/:id', asyncHandler(async (req, res) => {
  const deleted = await digitalTwinService.deleteDocument(req.params.id);
  if (!deleted) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// TESTING
// =============================================================================

/**
 * GET /api/digital-twin/tests
 * Get the behavioral test suite (parsed from BEHAVIORAL_TEST_SUITE.md)
 */
router.get('/tests', asyncHandler(async (req, res) => {
  const tests = await digitalTwinService.parseTestSuite();
  res.json(tests);
}));

/**
 * POST /api/digital-twin/tests/run
 * Run behavioral tests against a single provider/model
 */
router.post('/tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * POST /api/digital-twin/tests/run-multi
 * Run behavioral tests against multiple providers/models
 */
router.post('/tests/run-multi', asyncHandler(async (req, res) => {
  const { providers, testIds, personaId } = validateRequest(runMultiTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const io = req.app.get('io');

  // Run tests for each provider in parallel
  const results = await Promise.all(
    providers.map(async ({ providerId, model }) => {
      const result = await digitalTwinService.runTests(providerId, model, testIds, personaId).catch(err => ({
        providerId,
        model,
        error: err.message
      }));

      // Emit progress via Socket.IO
      if (io) {
        io.emit('digital-twin:test-progress', { providerId, model, result });
      }

      return { providerId, model, ...result };
    })
  );

  res.json(results);
}));

/**
 * GET /api/digital-twin/tests/history
 * Get test run history
 */
router.get('/tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getTestHistory(data.limit);
  res.json(history);
}));

// =============================================================================
// VALUES-ALIGNMENT TESTING (M34 P6)
// =============================================================================

/**
 * GET /api/digital-twin/values-tests
 * Get the values-alignment dilemma suite (parsed from VALUES_ALIGNMENT_SUITE.md)
 */
router.get('/values-tests', asyncHandler(async (req, res) => {
  const dilemmas = await digitalTwinService.parseValuesAlignmentSuite();
  res.json(dilemmas);
}));

/**
 * POST /api/digital-twin/values-tests/run
 * Run values-alignment dilemmas against a single provider/model, scoring each
 * response against the user's stored values hierarchy
 */
router.post('/values-tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runValuesAlignmentTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * GET /api/digital-twin/values-tests/history
 * Get values-alignment run history
 */
router.get('/values-tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getValuesAlignmentHistory(data.limit);
  res.json(history);
}));

// =============================================================================
// ADVERSARIAL BOUNDARY TESTING (M34 P6)
// =============================================================================

/**
 * GET /api/digital-twin/adversarial-tests
 * Get the adversarial-boundary scenario suite (parsed from ADVERSARIAL_BOUNDARY_SUITE.md)
 */
router.get('/adversarial-tests', asyncHandler(async (req, res) => {
  const scenarios = await digitalTwinService.parseAdversarialSuite();
  res.json(scenarios);
}));

/**
 * POST /api/digital-twin/adversarial-tests/run
 * Run adversarial-boundary scenarios against a single provider/model, scoring
 * whether the embodied twin held or breached each stated boundary
 */
router.post('/adversarial-tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runAdversarialTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * GET /api/digital-twin/adversarial-tests/history
 * Get adversarial-boundary run history
 */
router.get('/adversarial-tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getAdversarialTestHistory(data.limit);
  res.json(history);
}));

// =============================================================================
// MULTI-TURN CONVERSATION TESTING (M34 P6)
// =============================================================================

/**
 * GET /api/digital-twin/multi-turn-tests
 * Get the multi-turn conversation suite (parsed from MULTI_TURN_SUITE.md)
 */
router.get('/multi-turn-tests', asyncHandler(async (req, res) => {
  const scenarios = await digitalTwinService.parseMultiTurnSuite();
  res.json(scenarios);
}));

/**
 * POST /api/digital-twin/multi-turn-tests/run
 * Run multi-turn conversation scenarios against a single provider/model, scoring
 * whether the embodied twin stayed consistent across each conversation
 */
router.post('/multi-turn-tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runMultiTurnTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * GET /api/digital-twin/multi-turn-tests/history
 * Get multi-turn conversation run history
 */
router.get('/multi-turn-tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getMultiTurnTestHistory(data.limit);
  res.json(history);
}));

// =============================================================================
// ENRICHMENT
// =============================================================================

/**
 * GET /api/digital-twin/enrich/categories
 * List all enrichment categories
 */
router.get('/enrich/categories', asyncHandler(async (req, res) => {
  const categories = digitalTwinService.getEnrichmentCategories();
  res.json(categories);
}));

/**
 * GET /api/digital-twin/enrich/progress
 * Get enrichment progress
 */
router.get('/enrich/progress', asyncHandler(async (req, res) => {
  const progress = await digitalTwinService.getEnrichmentProgress();
  res.json(progress);
}));

/**
 * POST /api/digital-twin/enrich/question
 * Get next question for a category
 */
router.post('/enrich/question', asyncHandler(async (req, res) => {
  const { category, providerOverride, modelOverride, skipIndices } = validateRequest(enrichmentQuestionInputSchema, req.body);
  const question = await digitalTwinService.generateEnrichmentQuestion(category, providerOverride, modelOverride, skipIndices);
  res.json(question);
}));

/**
 * POST /api/digital-twin/enrich/answer
 * Submit answer and update digital twin documents
 */
router.post('/enrich/answer', asyncHandler(async (req, res) => {
  const data = validateRequest(enrichmentAnswerInputSchema, req.body);
  const result = await digitalTwinService.processEnrichmentAnswer(data);
  res.json(result);
}));

/**
 * POST /api/digital-twin/enrich/analyze-list
 * Analyze a list of items (books, movies, music) and generate document content
 */
router.post('/enrich/analyze-list', asyncHandler(async (req, res) => {
  const { category, items, providerId, model } = validateRequest(analyzeListInputSchema, req.body);
  const result = await digitalTwinService.analyzeEnrichmentList(category, items, providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/enrich/save-list
 * Save analyzed list content to document
 */
router.post('/enrich/save-list', asyncHandler(async (req, res) => {
  const { category, content, items } = validateRequest(saveListDocumentInputSchema, req.body);
  const result = await digitalTwinService.saveEnrichmentListDocument(category, content, items);
  res.json(result);
}));

/**
 * GET /api/digital-twin/enrich/list-items/:category
 * Get previously saved list items for a category
 */
router.get('/enrich/list-items/:category', asyncHandler(async (req, res) => {
  const data = validateRequest(getListItemsInputSchema, { category: req.params.category });
  const items = await digitalTwinService.getEnrichmentListItems(data.category);
  res.json(items);
}));

// =============================================================================
// EXPORT
// =============================================================================

/**
 * GET /api/digital-twin/export/formats
 * List available export formats
 */
router.get('/export/formats', asyncHandler(async (req, res) => {
  const formats = digitalTwinService.getExportFormats();
  res.json(formats);
}));

/**
 * POST /api/digital-twin/export
 * Export soul in specified format
 */
router.post('/export', asyncHandler(async (req, res) => {
  const { format, documentIds, includeDisabled } = validateRequest(exportInputSchema, req.body);
  const exported = await digitalTwinService.exportDigitalTwin(format, documentIds, includeDisabled);
  res.json(exported);
}));

// =============================================================================
// SETTINGS
// =============================================================================

/**
 * GET /api/digital-twin/settings
 * Get digital twin settings
 */
router.get('/settings', asyncHandler(async (req, res) => {
  const meta = await digitalTwinService.loadMeta();
  res.json(meta.settings);
}));

/**
 * PUT /api/digital-twin/settings
 * Update digital twin settings
 */
router.put('/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(settingsUpdateInputSchema, req.body);
  const settings = await digitalTwinService.updateSettings(data);
  res.json(settings);
}));

// =============================================================================
// PERSONAS (M34 P7)
// =============================================================================

/**
 * GET /api/digital-twin/personas
 * List all twin personas
 */
router.get('/personas', asyncHandler(async (req, res) => {
  res.json(await digitalTwinService.getPersonas());
}));

/**
 * POST /api/digital-twin/personas
 * Create a new persona
 */
router.post('/personas', asyncHandler(async (req, res) => {
  const data = validateRequest(createPersonaInputSchema, req.body);
  const persona = await digitalTwinService.createPersona(data);
  res.status(201).json(persona);
}));

/**
 * GET /api/digital-twin/personas/active
 * Get the currently active persona (null when none is set)
 * (Registered before /personas/:id so "active" isn't matched as an id.)
 */
router.get('/personas/active', asyncHandler(async (req, res) => {
  res.json(await digitalTwinService.getActivePersona());
}));

/**
 * PUT /api/digital-twin/personas/active
 * Set (or clear, with personaId: null) the active persona
 */
router.put('/personas/active', asyncHandler(async (req, res) => {
  const { personaId } = validateRequest(setActivePersonaInputSchema, req.body);
  if (personaId && !(await digitalTwinService.getPersonaById(personaId))) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
  const settings = await digitalTwinService.setActivePersona(personaId);
  res.json(settings);
}));

/**
 * PUT /api/digital-twin/personas/:id
 * Update a persona
 */
router.put('/personas/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid persona id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const data = validateRequest(updatePersonaInputSchema, req.body);
  if (!(await digitalTwinService.getPersonaById(id))) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(await digitalTwinService.updatePersona(id, data));
}));

/**
 * DELETE /api/digital-twin/personas/:id
 * Delete a persona (clears the active pointer if it was active)
 */
router.delete('/personas/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid persona id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { deleted } = await digitalTwinService.deletePersona(id);
  if (!deleted) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true });
}));

// =============================================================================
// VALIDATION & ANALYSIS
// =============================================================================

/**
 * GET /api/digital-twin/validate/completeness
 * Check digital twin document completeness
 */
router.get('/validate/completeness', asyncHandler(async (req, res) => {
  const result = await digitalTwinService.validateCompleteness();
  res.json(result);
}));

/**
 * POST /api/digital-twin/validate/contradictions
 * Detect contradictions in digital twin documents using AI
 */
router.post('/validate/contradictions', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(contradictionInputSchema, req.body);
  const result = await digitalTwinService.detectContradictions(providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/tests/generate
 * Generate behavioral tests from soul content
 */
router.post('/tests/generate', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(generateTestsInputSchema, req.body);
  const result = await digitalTwinService.generateDynamicTests(providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/analyze-writing
 * Analyze writing samples to extract communication patterns
 */
router.post('/analyze-writing', asyncHandler(async (req, res) => {
  const { samples, providerId, model } = validateRequest(writingAnalysisInputSchema, req.body);
  const result = await digitalTwinService.analyzeWritingSamples(samples, providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/style/spoken-written
 * Compare the user's spoken style (a transcript) against their written style
 * (pasted samples, or their twin documents) and surface the differences.
 */
router.post('/style/spoken-written', asyncHandler(async (req, res) => {
  const data = validateRequest(spokenWrittenStyleInputSchema, req.body);
  const result = await digitalTwinService.compareSpokenWrittenStyle(data);
  res.json(result);
}));

/**
 * POST /api/digital-twin/identity/image
 * Analyze a photo of the user with a vision model and extract visible
 * appearance / self-presentation descriptors (M34 P5 — multi-modal capture).
 */
router.post('/identity/image', asyncHandler(async (req, res) => {
  const data = validateRequest(identityImageInputSchema, req.body);
  const result = await digitalTwinService.analyzeIdentityImage(data);
  res.json(result);
}));

/**
 * POST /api/digital-twin/identity/image/save
 * Persist the appearance analysis as a Digital Twin identity document
 * (upserts APPEARANCE.md).
 */
router.post('/identity/image/save', asyncHandler(async (req, res) => {
  const data = validateRequest(identityImageSaveInputSchema, req.body);
  const result = await digitalTwinService.saveIdentityImageDocument(data);
  if (result?.error) {
    throw new ServerError(result.error, { status: 400, code: 'VALIDATION_ERROR' });
  }
  res.json(result);
}));

// =============================================================================
// TRAITS & CONFIDENCE (Phase 1 & 2)
// =============================================================================

/**
 * GET /api/digital-twin/traits
 * Get current personality traits
 */
router.get('/traits', asyncHandler(async (req, res) => {
  const traits = await digitalTwinService.getTraits();
  res.json({ traits });
}));

/**
 * POST /api/digital-twin/traits/analyze
 * Analyze documents to extract personality traits using AI
 */
router.post('/traits/analyze', asyncHandler(async (req, res) => {
  const { providerId, model, forceReanalyze } = validateRequest(analyzeTraitsInputSchema, req.body);
  const result = await digitalTwinService.analyzeTraits(providerId, model, forceReanalyze);
  res.json(result);
}));

/**
 * PUT /api/digital-twin/traits
 * Manually update personality traits
 */
router.put('/traits', asyncHandler(async (req, res) => {
  const data = validateRequest(updateTraitsInputSchema, req.body);
  const traits = await digitalTwinService.updateTraits(data);
  res.json({ traits });
}));

/**
 * GET /api/digital-twin/confidence
 * Get current confidence scores
 */
router.get('/confidence', asyncHandler(async (req, res) => {
  const confidence = await digitalTwinService.getConfidence();
  res.json({ confidence });
}));

/**
 * POST /api/digital-twin/confidence/calculate
 * Calculate confidence scores (optionally with AI analysis)
 */
router.post('/confidence/calculate', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(calculateConfidenceInputSchema, req.body);
  const result = await digitalTwinService.calculateConfidence(providerId, model);
  res.json(result);
}));

/**
 * GET /api/digital-twin/gaps
 * Get gap recommendations for personality enrichment
 */
router.get('/gaps', asyncHandler(async (req, res) => {
  const gaps = await digitalTwinService.getGapRecommendations();
  res.json({ gaps });
}));

// =============================================================================
// ASSESSMENT ANALYZER
// =============================================================================

/**
 * POST /api/digital-twin/interview/analyze
 * Analyze a pasted personality assessment and update twin profile
 */
router.post('/interview/analyze', asyncHandler(async (req, res) => {
  const { content, providerId, model } = validateRequest(analyzeAssessmentInputSchema, req.body);
  const result = await digitalTwinService.analyzeAssessment(content, providerId, model);

  if (result.error) {
    throw new ServerError(result.error, {
      status: 400,
      code: 'ANALYSIS_ERROR'
    });
  }

  res.json(result);
}));

// =============================================================================
// EXTERNAL DATA IMPORT (Phase 4)
// =============================================================================

/**
 * GET /api/digital-twin/import/sources
 * Get list of supported import sources
 */
router.get('/import/sources', asyncHandler(async (req, res) => {
  const sources = digitalTwinService.getImportSources();
  res.json({ sources });
}));

/**
 * POST /api/digital-twin/import/analyze
 * Analyze imported external data
 */
router.post('/import/analyze', asyncHandler(async (req, res) => {
  const { source, data, providerId, model } = validateRequest(importDataInputSchema, req.body);
  const result = await digitalTwinService.analyzeImportedData(source, data, providerId, model);

  if (result.error) {
    throw new ServerError(result.error, {
      status: 400,
      code: 'IMPORT_ANALYSIS_ERROR'
    });
  }

  res.json(result);
}));

/**
 * POST /api/digital-twin/import/save
 * Save import analysis as a document
 */
router.post('/import/save', asyncHandler(async (req, res) => {
  const { source, suggestedDoc } = validateRequest(importSaveSchema, req.body);
  const document = await digitalTwinService.saveImportAsDocument(source, suggestedDoc);
  res.json({ document, message: 'Document saved successfully' });
}));

// =============================================================================
// BEHAVIORAL FEEDBACK LOOP (M34 P3)
// =============================================================================

/**
 * POST /api/digital-twin/feedback
 * Submit a "sounds like me" / "doesn't sound like me" validation
 */
router.post('/feedback', asyncHandler(async (req, res) => {
  const data = validateRequest(feedbackInputSchema, req.body);
  const entry = await feedbackService.submitFeedback(data);
  res.json(entry);
}));

/**
 * GET /api/digital-twin/feedback/stats
 * Get feedback statistics and analysis
 */
router.get('/feedback/stats', asyncHandler(async (req, res) => {
  const stats = await feedbackService.getFeedbackStats();
  res.json(stats);
}));

/**
 * POST /api/digital-twin/feedback/recalculate
 * Recalculate document weight adjustments from feedback history
 */
router.post('/feedback/recalculate', asyncHandler(async (req, res) => {
  const result = await feedbackService.recalculateWeights();
  res.json(result);
}));

/**
 * GET /api/digital-twin/feedback/recent
 * Get recent feedback entries (optionally filtered by content type)
 */
router.get('/feedback/recent', asyncHandler(async (req, res) => {
  const contentType = req.query.contentType || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const entries = await feedbackService.getRecentFeedback(contentType, limit);
  res.json(entries);
}));

// =============================================================================
// TASTE QUESTIONNAIRE
// =============================================================================

/**
 * GET /api/digital-twin/taste
 * Get taste profile status and progress
 */
router.get('/taste', asyncHandler(async (req, res) => {
  const profile = await tasteService.getTasteProfile();
  res.json(profile);
}));

/**
 * GET /api/digital-twin/taste/sections
 * Get available taste sections with question definitions
 */
router.get('/taste/sections', asyncHandler(async (req, res) => {
  const sections = Object.entries(tasteService.TASTE_SECTIONS).map(([id, config]) => ({
    id,
    label: config.label,
    description: config.description,
    icon: config.icon,
    color: config.color,
    questionCount: config.questions.length
  }));
  res.json(sections);
}));

/**
 * GET /api/digital-twin/taste/:section/next
 * Get the next question for a taste section
 */
router.get('/taste/:section/next', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const question = await tasteService.getNextQuestion(parsed.data);
  res.json(question);
}));

/**
 * POST /api/digital-twin/taste/answer
 * Submit an answer for a taste question
 */
router.post('/taste/answer', asyncHandler(async (req, res) => {
  const { section, questionId, answer, source, generatedQuestion, identityContextUsed } = validateRequest(tasteAnswerInputSchema, req.body);
  const result = await tasteService.submitAnswer(section, questionId, answer, { source, generatedQuestion, identityContextUsed });
  res.json(result);
}));

/**
 * GET /api/digital-twin/taste/:section/responses
 * Get all responses for a taste section
 */
router.get('/taste/:section/responses', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const responses = await tasteService.getSectionResponses(parsed.data);
  res.json(responses);
}));

/**
 * POST /api/digital-twin/taste/summary
 * Generate a taste profile summary (section or overall)
 */
router.post('/taste/summary', asyncHandler(async (req, res) => {
  const { section, providerId, model } = validateRequest(tasteSummaryInputSchema, req.body);

  const result = section
    ? await tasteService.generateSectionSummary(section, providerId, model)
    : await tasteService.generateOverallSummary(providerId, model);

  res.json(result);
}));

/**
 * POST /api/digital-twin/taste/:section/personalized-question
 * Generate a personalized follow-up question using identity context
 */
router.post('/taste/:section/personalized-question', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const { providerId, model } = validateRequest(tastePersonalizedQuestionInputSchema, req.body);
  const question = await tasteService.generatePersonalizedTasteQuestion(parsed.data, providerId, model);
  res.json(question);
}));

/**
 * DELETE /api/digital-twin/taste/:section
 * Reset a taste section
 */
router.delete('/taste/:section', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const result = await tasteService.resetSection(parsed.data);
  res.json(result);
}));

// =============================================================================
// TIME CAPSULE SNAPSHOTS
// =============================================================================

/**
 * GET /api/digital-twin/snapshots
 * List all time capsule snapshots (metadata only)
 */
router.get('/snapshots', asyncHandler(async (req, res) => {
  const snapshots = await timeCapsuleService.listSnapshots();
  res.json(snapshots);
}));

/**
 * POST /api/digital-twin/snapshots
 * Create a new time capsule snapshot
 */
router.post('/snapshots', asyncHandler(async (req, res) => {
  const data = validateRequest(createSnapshotInputSchema, req.body);
  const snapshot = await timeCapsuleService.createSnapshot(data.label, data.description);
  res.status(201).json(snapshot);
}));

/**
 * GET /api/digital-twin/snapshots/:id
 * Get a snapshot with full data
 */
router.get('/snapshots/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid snapshot ID', { status: 400 });
  }
  const snapshot = await timeCapsuleService.getSnapshot(id);
  if (!snapshot) {
    throw new ServerError('Snapshot not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(snapshot);
}));

/**
 * DELETE /api/digital-twin/snapshots/:id
 * Delete a snapshot
 */
router.delete('/snapshots/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid snapshot ID', { status: 400 });
  }
  const deleted = await timeCapsuleService.deleteSnapshot(id);
  if (!deleted) {
    throw new ServerError('Snapshot not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true });
}));

/**
 * POST /api/digital-twin/snapshots/compare
 * Compare two snapshots
 */
router.post('/snapshots/compare', asyncHandler(async (req, res) => {
  const data = validateRequest(compareSnapshotsInputSchema, req.body);
  const diff = await timeCapsuleService.compareSnapshots(data.id1, data.id2);
  if (!diff) {
    throw new ServerError('One or both snapshots not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(diff);
}));

// =============================================================================
// TWIN ENRICHMENT — observed taste + chronotype evidence (Phase 7, #2156)
// =============================================================================

/**
 * GET /api/digital-twin/twin-evidence
 * Observed taste + chronotype evidence, plus the stated-vs-observed chronotype
 * divergence flag. Read-only, LLM-free. `taste`/`chronotype` are null until the
 * first aggregation runs (sentinel: null = never computed, not empty).
 */
router.get('/twin-evidence', asyncHandler(async (req, res) => {
  const evidence = await twinEnrichment.getObservedEvidence();
  res.json(evidence);
}));

/**
 * POST /api/digital-twin/twin-evidence/recompute
 * Recompute the LLM-free rollups from the activity timeline. No provider calls.
 */
router.post('/twin-evidence/recompute', asyncHandler(async (req, res) => {
  validateRequest(twinEvidenceRecomputeInputSchema, req.body ?? {});
  const summary = await twinEnrichment.aggregateTwinEvidence();
  const evidence = await twinEnrichment.getObservedEvidence();
  res.json({ summary, evidence });
}));

/**
 * POST /api/digital-twin/twin-evidence/interpret
 * Generate an AI interpretation of the observed evidence — EXPLICIT user action
 * only (per the AI-provider policy). Persists the narrative onto the taste
 * evidence record.
 */
router.post('/twin-evidence/interpret', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(twinEvidenceInterpretInputSchema, req.body);
  const interpretation = await twinEnrichment.interpretConsumption({ providerId, model });
  res.json({ interpretation });
}));

export default router;
