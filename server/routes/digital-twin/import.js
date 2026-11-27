/**
 * Digital Twin external data import (Phase 4) — list sources, analyze imported
 * data, and save an analysis as a document.
 */

import { importSaveSchema, spotifyBrowserImportSchema } from '../../lib/digitalTwinImportValidation.js';
import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { importDataInputSchema } from '../../lib/digitalTwinValidation.js';
import * as spotifyBrowserImport from '../../services/spotifyBrowserImport.js';

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
 * POST /api/digital-twin/import/spotify/browser/open
 * Open Spotify's fixed privacy page in the PortOS managed browser.
 *
 * The browser keeps its own session, so this endpoint never accepts a URL or
 * Spotify credential. A signed-out browser returns an auth-required state for
 * the UI to render rather than turning the login page into an API error.
 */
router.post('/import/spotify/browser/open', asyncHandler(async (req, res) => {
  res.json(await spotifyBrowserImport.openSpotifyBrowser());
}));

/**
 * POST /api/digital-twin/import/spotify/browser/import
 * Request/read the Spotify browser export and analyze it without a file upload.
 */
router.post('/import/spotify/browser/import', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(spotifyBrowserImportSchema, req.body);
  res.json(await spotifyBrowserImport.importSpotifyFromBrowser(providerId, model));
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
