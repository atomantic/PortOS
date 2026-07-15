/**
 * Digital Twin export — list available formats and export the soul.
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { exportInputSchema } from '../../lib/digitalTwinValidation.js';

const router = Router();

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

export default router;
