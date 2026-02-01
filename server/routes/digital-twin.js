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
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate } from '../lib/validation.js';
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
  importDataInputSchema
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
  const validation = validate(createDocumentInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const document = await digitalTwinService.createDocument(validation.data);
  res.status(201).json(document);
}));

/**
 * PUT /api/digital-twin/documents/:id
 * Update a document
 */
router.put('/documents/:id', asyncHandler(async (req, res) => {
  const validation = validate(updateDocumentInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const document = await digitalTwinService.updateDocument(req.params.id, validation.data);
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
  const validation = validate(runTestsInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { providerId, model, testIds } = validation.data;
  const result = await digitalTwinService.runTests(providerId, model, testIds);
  res.json(result);
}));

/**
 * POST /api/digital-twin/tests/run-multi
 * Run behavioral tests against multiple providers/models
 */
router.post('/tests/run-multi', asyncHandler(async (req, res) => {
  const validation = validate(runMultiTestsInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { providers, testIds } = validation.data;
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
  const validation = validate(testHistoryQuerySchema, req.query);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const history = await digitalTwinService.getTestHistory(validation.data.limit);
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
  const validation = validate(enrichmentQuestionInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { category, providerOverride, modelOverride } = validation.data;
  const question = await digitalTwinService.generateEnrichmentQuestion(category, providerOverride, modelOverride);
  res.json(question);
}));

/**
 * POST /api/digital-twin/enrich/answer
 * Submit answer and update digital twin documents
 */
router.post('/enrich/answer', asyncHandler(async (req, res) => {
  const validation = validate(enrichmentAnswerInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const result = await digitalTwinService.processEnrichmentAnswer(validation.data);
  res.json(result);
}));

/**
 * POST /api/digital-twin/enrich/analyze-list
 * Analyze a list of items (books, movies, music) and generate document content
 */
router.post('/enrich/analyze-list', asyncHandler(async (req, res) => {
  const validation = validate(analyzeListInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { category, items, providerId, model } = validation.data;
  const result = await digitalTwinService.analyzeEnrichmentList(category, items, providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/enrich/save-list
 * Save analyzed list content to document
 */
router.post('/enrich/save-list', asyncHandler(async (req, res) => {
  const validation = validate(saveListDocumentInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { category, content, items } = validation.data;
  const result = await digitalTwinService.saveEnrichmentListDocument(category, content, items);
  res.json(result);
}));

/**
 * GET /api/digital-twin/enrich/list-items/:category
 * Get previously saved list items for a category
 */
router.get('/enrich/list-items/:category', asyncHandler(async (req, res) => {
  const validation = validate(getListItemsInputSchema, { category: req.params.category });
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const items = await digitalTwinService.getEnrichmentListItems(validation.data.category);
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
  const validation = validate(exportInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { format, documentIds, includeDisabled } = validation.data;
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
  const validation = validate(settingsUpdateInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const settings = await digitalTwinService.updateSettings(validation.data);
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
  const validation = validate(contradictionInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { providerId, model } = validation.data;
  const result = await digitalTwinService.detectContradictions(providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/tests/generate
 * Generate behavioral tests from soul content
 */
router.post('/tests/generate', asyncHandler(async (req, res) => {
  const validation = validate(generateTestsInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { providerId, model } = validation.data;
  const result = await digitalTwinService.generateDynamicTests(providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/analyze-writing
 * Analyze writing samples to extract communication patterns
 */
router.post('/analyze-writing', asyncHandler(async (req, res) => {
  const validation = validate(writingAnalysisInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { samples, providerId, model } = validation.data;
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
  const validation = validate(analyzeTraitsInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { providerId, model, forceReanalyze } = validation.data;
  const result = await digitalTwinService.analyzeTraits(providerId, model, forceReanalyze);
  res.json(result);
}));

/**
 * PUT /api/digital-twin/traits
 * Manually update personality traits
 */
router.put('/traits', asyncHandler(async (req, res) => {
  const validation = validate(updateTraitsInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const traits = await digitalTwinService.updateTraits(validation.data);
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
  const validation = validate(calculateConfidenceInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { providerId, model } = validation.data;
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
  const validation = validate(importDataInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { source, data, providerId, model } = validation.data;
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

export default router;
