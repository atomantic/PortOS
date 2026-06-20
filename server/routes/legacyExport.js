import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, legacyExportSchema } from '../lib/validation.js';
import { buildLegacyZip, previewLegacyExport } from '../services/legacyExport.js';

const router = Router();

// GET /api/legacy-export/preview — section presence + counts + estimated size,
// without building the zip. Cheap enough to call on page load.
router.get('/preview', asyncHandler(async (req, res) => {
  const preview = await previewLegacyExport();
  res.json(preview);
}));

// POST /api/legacy-export — build and stream the identity bundle as a zip
// attachment. `sections` (optional) narrows the bundle; omitted means "all".
router.post('/', asyncHandler(async (req, res) => {
  const { sections, includePdf } = validateRequest(legacyExportSchema, req.body || {});
  const io = req.app.get('io');
  const { buffer } = await buildLegacyZip({ sections: sections || null, includePdf: !!includePdf, io });

  // Date-stamped filename, mirroring the catalog download pattern.
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="legacy-export-${date}.zip"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.send(buffer);
}));

export default router;
