import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  importerAnalyzeSchema,
  importerCommitSchema,
} from '../lib/validation.js';
import {
  analyzeImport,
  commitImport,
  ERR_VALIDATION,
  ERR_LOCKED,
} from '../services/importer.js';
import * as universeSvc from '../services/universeBuilder.js';
import * as seriesSvc from '../services/pipeline/series.js';

const router = Router();

// The orchestrator throws its own validation/locked codes directly. Missing
// universe / series codes bubble through `getUniverse` / `getSeries` with
// their service-native codes (`NOT_FOUND` / `PIPELINE_SERIES_NOT_FOUND`),
// not an importer-prefixed alias — map those to 404.
const SERVICE_ERROR_STATUS = {
  [ERR_VALIDATION]: 400,
  [ERR_LOCKED]: 400,
  [universeSvc.ERR_NOT_FOUND]: 404,
  [seriesSvc.ERR_NOT_FOUND]: 404,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

router.post('/analyze', asyncHandler(async (req, res) => {
  const input = validateRequest(importerAnalyzeSchema, req.body || {});
  const result = await analyzeImport(input).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.post('/commit', asyncHandler(async (req, res) => {
  const input = validateRequest(importerCommitSchema, req.body || {});
  const result = await commitImport(input).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
