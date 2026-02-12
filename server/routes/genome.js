import { Router } from 'express';
import * as genomeService from '../services/genome.js';
import * as clinvarService from '../services/clinvar.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate } from '../lib/validation.js';
import {
  genomeUploadSchema,
  genomeSearchSchema,
  genomeSaveMarkerSchema,
  genomeUpdateNotesSchema
} from '../lib/genomeValidation.js';

const router = Router();

// GET /api/digital-twin/genome — Summary
router.get('/', asyncHandler(async (req, res) => {
  const summary = await genomeService.getGenomeSummary();
  res.json(summary);
}));

// POST /api/digital-twin/genome/upload — Upload genome file
router.post('/upload', asyncHandler(async (req, res) => {
  const validation = validate(genomeUploadSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const result = await genomeService.uploadGenome(validation.data.content, validation.data.filename);
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
  const validation = validate(genomeSearchSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const result = await genomeService.searchSNP(validation.data.rsid);
  res.json(result);
}));

// POST /api/digital-twin/genome/markers — Save a marker
router.post('/markers', asyncHandler(async (req, res) => {
  const validation = validate(genomeSaveMarkerSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const marker = await genomeService.saveMarker(validation.data);
  res.status(201).json(marker);
}));

// PUT /api/digital-twin/genome/markers/:id/notes — Update marker notes
router.put('/markers/:id/notes', asyncHandler(async (req, res) => {
  const validation = validate(genomeUpdateNotesSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const result = await genomeService.updateMarkerNotes(req.params.id, validation.data.notes);
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

// DELETE /api/digital-twin/genome — Delete all genome data
router.delete('/', asyncHandler(async (req, res) => {
  await genomeService.deleteGenome();
  await clinvarService.deleteClinvar();
  res.status(204).end();
}));

export default router;
