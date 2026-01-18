/**
 * Soul API Routes
 *
 * Handles all HTTP endpoints for the Soul feature:
 * - Document CRUD
 * - Behavioral testing
 * - Enrichment questionnaire
 * - Export
 * - Settings
 */

import { Router } from 'express';
import * as soulService from '../services/soul.js';
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
  writingAnalysisInputSchema
} from '../lib/soulValidation.js';

const router = Router();

// =============================================================================
// STATUS & SUMMARY
// =============================================================================

/**
 * GET /api/soul
 * Get soul status summary
 */
router.get('/', asyncHandler(async (req, res) => {
  const status = await soulService.getSoulStatus();
  res.json(status);
}));

// =============================================================================
// DOCUMENTS
// =============================================================================

/**
 * GET /api/soul/documents
 * List all soul documents
 */
router.get('/documents', asyncHandler(async (req, res) => {
  const documents = await soulService.getDocuments();
  res.json(documents);
}));

/**
 * GET /api/soul/documents/:id
 * Get a single document with content
 */
router.get('/documents/:id', asyncHandler(async (req, res) => {
  const document = await soulService.getDocumentById(req.params.id);
  if (!document) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(document);
}));

/**
 * POST /api/soul/documents
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

  const document = await soulService.createDocument(validation.data);
  res.status(201).json(document);
}));

/**
 * PUT /api/soul/documents/:id
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

  const document = await soulService.updateDocument(req.params.id, validation.data);
  if (!document) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(document);
}));

/**
 * DELETE /api/soul/documents/:id
 * Delete a document
 */
router.delete('/documents/:id', asyncHandler(async (req, res) => {
  const deleted = await soulService.deleteDocument(req.params.id);
  if (!deleted) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// TESTING
// =============================================================================

/**
 * GET /api/soul/tests
 * Get the behavioral test suite (parsed from BEHAVIORAL_TEST_SUITE.md)
 */
router.get('/tests', asyncHandler(async (req, res) => {
  const tests = await soulService.parseTestSuite();
  res.json(tests);
}));

/**
 * POST /api/soul/tests/run
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
  const result = await soulService.runTests(providerId, model, testIds);
  res.json(result);
}));

/**
 * POST /api/soul/tests/run-multi
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
      const result = await soulService.runTests(providerId, model, testIds).catch(err => ({
        providerId,
        model,
        error: err.message
      }));

      // Emit progress via Socket.IO
      if (io) {
        io.emit('soul:test-progress', { providerId, model, result });
      }

      return { providerId, model, ...result };
    })
  );

  res.json(results);
}));

/**
 * GET /api/soul/tests/history
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

  const history = await soulService.getTestHistory(validation.data.limit);
  res.json(history);
}));

// =============================================================================
// ENRICHMENT
// =============================================================================

/**
 * GET /api/soul/enrich/categories
 * List all enrichment categories
 */
router.get('/enrich/categories', asyncHandler(async (req, res) => {
  const categories = soulService.getEnrichmentCategories();
  res.json(categories);
}));

/**
 * GET /api/soul/enrich/progress
 * Get enrichment progress
 */
router.get('/enrich/progress', asyncHandler(async (req, res) => {
  const progress = await soulService.getEnrichmentProgress();
  res.json(progress);
}));

/**
 * POST /api/soul/enrich/question
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
  const question = await soulService.generateEnrichmentQuestion(category, providerOverride, modelOverride);
  res.json(question);
}));

/**
 * POST /api/soul/enrich/answer
 * Submit answer and update soul documents
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

  const result = await soulService.processEnrichmentAnswer(validation.data);
  res.json(result);
}));

// =============================================================================
// EXPORT
// =============================================================================

/**
 * GET /api/soul/export/formats
 * List available export formats
 */
router.get('/export/formats', asyncHandler(async (req, res) => {
  const formats = soulService.getExportFormats();
  res.json(formats);
}));

/**
 * POST /api/soul/export
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
  const exported = await soulService.exportSoul(format, documentIds, includeDisabled);
  res.json(exported);
}));

// =============================================================================
// SETTINGS
// =============================================================================

/**
 * GET /api/soul/settings
 * Get soul settings
 */
router.get('/settings', asyncHandler(async (req, res) => {
  const meta = await soulService.loadMeta();
  res.json(meta.settings);
}));

/**
 * PUT /api/soul/settings
 * Update soul settings
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

  const settings = await soulService.updateSettings(validation.data);
  res.json(settings);
}));

// =============================================================================
// VALIDATION & ANALYSIS
// =============================================================================

/**
 * GET /api/soul/validate/completeness
 * Check soul document completeness
 */
router.get('/validate/completeness', asyncHandler(async (req, res) => {
  const result = await soulService.validateCompleteness();
  res.json(result);
}));

/**
 * POST /api/soul/validate/contradictions
 * Detect contradictions in soul documents using AI
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
  const result = await soulService.detectContradictions(providerId, model);
  res.json(result);
}));

/**
 * POST /api/soul/tests/generate
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
  const result = await soulService.generateDynamicTests(providerId, model);
  res.json(result);
}));

/**
 * POST /api/soul/analyze-writing
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
  const result = await soulService.analyzeWritingSamples(samples, providerId, model);
  res.json(result);
}));

export default router;
