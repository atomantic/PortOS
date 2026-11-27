/**
 * System Resources — explicit storage report and AI-assisted cleanup triage.
 *
 * Both routes are POSTs because a report performs bounded, potentially slow
 * disk scans. Nothing runs at boot or merely because a dashboard widget polls.
 */

import { duplicatePairsSchema, emptyBodySchema, systemResourceTriageSchema } from '../lib/systemResourcesValidation.js';
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { onClientDisconnect } from '../lib/sseDownload.js';
import { stopRun } from '../services/runner.js';
import { getSystemResourceReport, getTrackedModelInventory, triageSystemResources } from '../services/systemResources.js';
import { rectifyModelDuplicates } from '../services/modelDeduplication.js';

const router = Router();

router.post('/duplicates/rectify', asyncHandler(async (req, res) => {
  const { pairs, mode } = validateRequest(duplicatePairsSchema, req.body);
  res.json(await rectifyModelDuplicates(pairs, { mode }));
}));

// GET, unlike everything else here, because it performs NO scan: it reads the
// model manifest PortOS maintains at install/uninstall time. That is the whole
// point — Models → Status can show the downloaded-model inventory on arrival,
// and a scan (POST /report) becomes the explicit "re-check the disk" action.
router.get('/models/manifest', asyncHandler(async (_req, res) => {
  res.json(await getTrackedModelInventory());
}));

router.post('/report', asyncHandler(async (req, res) => {
  validateRequest(emptyBodySchema, req.body || {});
  res.json(await getSystemResourceReport({ force: true }));
}));

router.post('/triage', asyncHandler(async (req, res) => {
  const input = validateRequest(systemResourceTriageSchema, req.body || {});
  const activeRunIds = new Set();
  let clientGone = false;
  const stop = (runId) => stopRun(runId).catch((err) => {
    console.error(`❌ Failed to stop disconnected system-resource triage run ${runId}: ${err.message}`);
  });
  onClientDisconnect(req, res, () => {
    clientGone = true;
    for (const runId of activeRunIds) stop(runId);
  });
  const result = await triageSystemResources({
    ...input,
    onRunCreated: (runId) => {
      activeRunIds.add(runId);
      if (clientGone) stop(runId);
    },
    onRunSettled: (runId) => activeRunIds.delete(runId),
  }).catch((err) => {
    if (clientGone) return null;
    throw err;
  });
  if (!clientGone && result && !res.writableEnded && !res.destroyed) res.json(result);
}));

export default router;

export { systemResourceTriageSchema } from "../lib/systemResourcesValidation.js";
