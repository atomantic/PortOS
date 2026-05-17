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
  ERR_PARTIAL_COMMIT_ISSUES,
  IMPORTER_SOURCE_CHAR_LIMIT,
} from '../services/importer.js';
import { ARC_ROLES } from '../lib/storyArc.js';
import * as universeSvc from '../services/universeBuilder.js';
import * as seriesSvc from '../services/pipeline/series.js';

const router = Router();

// The orchestrator throws its own validation/locked codes directly. Missing
// universe / series codes bubble through `getUniverse` / `getSeries` with
// their service-native codes (`NOT_FOUND` / `PIPELINE_SERIES_NOT_FOUND`),
// not an importer-prefixed alias — map those to 404.
// `ERR_PARTIAL_COMMIT_ISSUES` maps to 422 (not 500) because the universe +
// series writes succeeded and only the issue loop was rolled back —
// alerting / generic-retry middleware that pages on 5xx would otherwise
// treat this user-action-recoverable state as an infra failure. We picked
// 422 over the original 207 because the client `request()` helper treats
// 207 as a 2xx success (response.ok === true) and would interpret the
// error body as a normal commit result, mis-toasting "Imported 0 issues"
// and crashing on the missing createdIssueIds. 422 makes the helper throw
// so the existing error toast surfaces the orchestrator's message
// ("universe + series saved, retry to create the remaining issues").
const SERVICE_ERROR_STATUS = {
  [ERR_VALIDATION]: 400,
  [ERR_LOCKED]: 409,
  [ERR_PARTIAL_COMMIT_ISSUES]: 422,
  [universeSvc.ERR_NOT_FOUND]: 404,
  [seriesSvc.ERR_NOT_FOUND]: 404,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

// Surfaces server-canonical constants so the client doesn't hardcode (and
// drift from) the source-char limit or the arc-role enum. Read by the
// Importer intake form on mount; the analyze response also includes these
// for clients that skip the config call.
router.get('/config', asyncHandler(async (req, res) => {
  res.json({
    sourceCharLimit: IMPORTER_SOURCE_CHAR_LIMIT,
    arcRoles: [...ARC_ROLES],
  });
}));

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
