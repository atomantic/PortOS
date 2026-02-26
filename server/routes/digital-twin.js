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
  feedbackInputSchema
} from '../lib/digitalTwinValidation.js';

const router = Router();

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
  const { providerId, model, testIds } = validateRequest(runTestsInputSchema, req.body);
  const result = await digitalTwinService.runTests(providerId, model, testIds);
  res.json(result);
}));

/**
 * POST /api/digital-twin/tests/run-multi
 * Run behavioral tests against multiple providers/models
 */
router.post('/tests/run-multi', asyncHandler(async (req, res) => {
  const { providers, testIds } = validateRequest(runMultiTestsInputSchema, req.body);
  const io = req.app.get('io');

  // Run tests for each provider in parallel
  const results = await Promise.all(
    providers.map(async ({ providerId, model }) => {
      const result = await digitalTwinService.runTests(providerId, model, testIds).catch(err => ({
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
  const { source, suggestedDoc } = req.body;

  if (!source || !suggestedDoc || !suggestedDoc.filename || !suggestedDoc.content) {
    throw new ServerError('Missing required fields: source and suggestedDoc', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

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
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
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

export default router;
