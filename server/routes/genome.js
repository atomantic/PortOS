import { Router } from 'express';
import * as genomeService from '../services/genome.js';
import * as clinvarService from '../services/clinvar.js';
import * as epigeneticService from '../services/epigenetic.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  genomeUploadSchema,
  genomeSearchSchema,
  genomeSaveMarkerSchema,
  genomeUpdateNotesSchema,
  epigeneticAddInterventionSchema,
  epigeneticLogEntrySchema,
  epigeneticUpdateInterventionSchema
} from '../lib/genomeValidation.js';

const router = Router();

// GET /api/digital-twin/genome — Summary
router.get('/', asyncHandler(async (req, res) => {
  const summary = await genomeService.getGenomeSummary();
  res.json(summary);
}));

// POST /api/digital-twin/genome/upload — Upload genome file
router.post('/upload', asyncHandler(async (req, res) => {
  const data = validateRequest(genomeUploadSchema, req.body);
  const result = await genomeService.uploadGenome(data.content, data.filename);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 400,
      code: 'GENOME_UPLOAD_ERROR'
    });
  }

  res.status(201).json(result);
}));

// POST /api/digital-twin/genome/scan — Scan curated markers
router.post('/scan', asyncHandler(async (req, res) => {
  const result = await genomeService.scanCuratedMarkers();
  if (result.error) {
    throw new ServerError(result.error, {
      status: 400,
      code: 'GENOME_SCAN_ERROR'
    });
  }

  res.json(result);
}));

// POST /api/digital-twin/genome/search — Search SNP by rsid
router.post('/search', asyncHandler(async (req, res) => {
  const data = validateRequest(genomeSearchSchema, req.body);
  const result = await genomeService.searchSNP(data.rsid);
  res.json(result);
}));

// POST /api/digital-twin/genome/markers — Save a marker
router.post('/markers', asyncHandler(async (req, res) => {
  const data = validateRequest(genomeSaveMarkerSchema, req.body);
  const marker = await genomeService.saveMarker(data);
  res.status(201).json(marker);
}));

// PUT /api/digital-twin/genome/markers/:id/notes — Update marker notes
router.put('/markers/:id/notes', asyncHandler(async (req, res) => {
  const data = validateRequest(genomeUpdateNotesSchema, req.body);
  const result = await genomeService.updateMarkerNotes(req.params.id, data.notes);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 404,
      code: 'MARKER_NOT_FOUND'
    });
  }

  res.json(result);
}));

// DELETE /api/digital-twin/genome/markers/:id — Delete a marker
router.delete('/markers/:id', asyncHandler(async (req, res) => {
  const result = await genomeService.deleteMarker(req.params.id);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 404,
      code: 'MARKER_NOT_FOUND'
    });
  }

  res.status(204).end();
}));

// === ClinVar Routes ===

// GET /api/digital-twin/genome/clinvar/status — ClinVar sync status
router.get('/clinvar/status', asyncHandler(async (req, res) => {
  const status = await clinvarService.getClinvarStatus();
  res.json(status);
}));

// POST /api/digital-twin/genome/clinvar/sync — Download and index ClinVar database
router.post('/clinvar/sync', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const onProgress = (message) => {
    if (io) io.emit('genome:clinvar-progress', { message });
  };

  const result = await clinvarService.syncClinvar(onProgress);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 500,
      code: 'CLINVAR_SYNC_ERROR'
    });
  }

  clinvarService.invalidateClinvarCache();
  res.json(result);
}));

// POST /api/digital-twin/genome/clinvar/scan — Scan genome against ClinVar
router.post('/clinvar/scan', asyncHandler(async (req, res) => {
  const snpIndex = await genomeService.getSnpIndex();
  if (!snpIndex) {
    throw new ServerError('No genome data uploaded', {
      status: 400,
      code: 'NO_GENOME_DATA'
    });
  }

  const result = await clinvarService.scanClinvar(snpIndex);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 400,
      code: 'CLINVAR_SCAN_ERROR'
    });
  }

  res.json(result);
}));

// DELETE /api/digital-twin/genome/clinvar — Delete ClinVar data
router.delete('/clinvar', asyncHandler(async (req, res) => {
  await clinvarService.deleteClinvar();
  res.status(204).end();
}));

// === Epigenetic Lifestyle Tracking Routes ===

// GET /api/digital-twin/genome/epigenetic — Get tracked interventions
router.get('/epigenetic', asyncHandler(async (req, res) => {
  const data = await epigeneticService.getInterventions();
  res.json(data);
}));

// GET /api/digital-twin/genome/epigenetic/recommendations — Get curated recommendations
router.get('/epigenetic/recommendations', asyncHandler(async (req, res) => {
  const categories = req.query.categories ? req.query.categories.split(',') : [];
  const recommendations = epigeneticService.getRecommendations(categories);
  res.json({ recommendations });
}));

// GET /api/digital-twin/genome/epigenetic/compliance — Get compliance summary
router.get('/epigenetic/compliance', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const summary = await epigeneticService.getComplianceSummary(days);
  res.json(summary);
}));

// POST /api/digital-twin/genome/epigenetic — Add intervention
router.post('/epigenetic', asyncHandler(async (req, res) => {
  const data = validateRequest(epigeneticAddInterventionSchema, req.body);
  const result = await epigeneticService.addIntervention(data);
  res.status(201).json(result);
}));

// POST /api/digital-twin/genome/epigenetic/:id/log — Log daily entry
router.post('/epigenetic/:id/log', asyncHandler(async (req, res) => {
  const data = validateRequest(epigeneticLogEntrySchema, req.body);
  const result = await epigeneticService.logEntry(req.params.id, data);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 404,
      code: 'INTERVENTION_NOT_FOUND'
    });
  }

  res.status(201).json(result);
}));

// PUT /api/digital-twin/genome/epigenetic/:id — Update intervention
router.put('/epigenetic/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(epigeneticUpdateInterventionSchema, req.body);
  const result = await epigeneticService.updateIntervention(req.params.id, data);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 404,
      code: 'INTERVENTION_NOT_FOUND'
    });
  }

  res.json(result);
}));

// DELETE /api/digital-twin/genome/epigenetic/:id — Delete intervention
router.delete('/epigenetic/:id', asyncHandler(async (req, res) => {
  const result = await epigeneticService.deleteIntervention(req.params.id);
  if (result.error) {
    throw new ServerError(result.error, {
      status: 404,
      code: 'INTERVENTION_NOT_FOUND'
    });
  }

  res.status(204).end();
}));

// DELETE /api/digital-twin/genome — Delete all genome data
router.delete('/', asyncHandler(async (req, res) => {
  await genomeService.deleteGenome();
  await clinvarService.deleteClinvar();
  res.status(204).end();
}));

export default router;
