/**
 * Digital Twin enrichment questionnaire — categories, progress, question/answer
 * flow, and list-based enrichment (books/movies/music).
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  enrichmentQuestionInputSchema,
  enrichmentAnswerInputSchema,
  analyzeListInputSchema,
  saveListDocumentInputSchema,
  getListItemsInputSchema,
} from '../../lib/digitalTwinValidation.js';

const router = Router();

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

export default router;
