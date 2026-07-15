/**
 * Digital Twin external data import (Phase 4) — list sources, analyze imported
 * data, and save an analysis as a document.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { importDataInputSchema } from '../../lib/digitalTwinValidation.js';

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

export default router;
