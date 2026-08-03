/**
 * Quota Burn routes — the install-level burn plan, its live status, and manual
 * runs. One loop for the whole install (see services/quotaBurnRunner.js); the
 * work it dispatches may target any managed app, named per job.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, quotaBurnConfigUpdateSchema, quotaBurnRunSchema } from '../lib/validation.js';
import { QUOTA_BURN_FAMILIES, QUOTA_BURN_JOB_CATALOG } from '../lib/quotaBurnConfig.js';
import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE } from '../services/imageGen/modes.js';
import { getQuotaBurnConfig, saveQuotaBurnConfig } from '../services/quotaBurnStore.js';
import { getQuotaBurnStatus, runQuotaBurnCycle } from '../services/quotaBurnRunner.js';
import { getActiveApps } from '../services/apps.js';
import { listUniverses } from '../services/universeBuilder.js';

const router = Router();

// GET /api/quota-burn — plan + live status (quota cards, per-job pending counts,
// why each family would or wouldn't burn, recent runs). `?refresh=1` re-scrapes
// provider usage; the default read is cached so opening the page is free.
router.get('/', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const [config, status] = await Promise.all([getQuotaBurnConfig(), getQuotaBurnStatus({ refresh })]);
  res.json({ config, status });
}));

// GET /api/quota-burn/catalog — everything the config form needs to build its
// pickers in one round trip: job types + their param descriptors, the family
// list, and the app/universe/render-backend options those params select from.
router.get('/catalog', asyncHandler(async (_req, res) => {
  const [apps, universes] = await Promise.all([
    getActiveApps(),
    // A missing/empty universe store must not 500 the config page — the
    // universe job simply has nothing to pick from.
    listUniverses().catch(() => []),
  ]);
  res.json({
    families: QUOTA_BURN_FAMILIES,
    jobTypes: QUOTA_BURN_JOB_CATALOG,
    apps: (apps || []).map((app) => ({ id: app.id, name: app.name })),
    universes: universes.map((universe) => ({ id: universe.id, name: universe.name })),
    imageModes: [...CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE.LOCAL],
  });
}));

// PUT /api/quota-burn — merge a partial plan. Top-level and per-family keys
// merge; a family's `jobs` array replaces.
router.put('/', asyncHandler(async (req, res) => {
  const patch = validateRequest(quotaBurnConfigUpdateSchema, req.body);
  const config = await saveQuotaBurnConfig(patch);
  res.json({ config });
}));

// POST /api/quota-burn/run — evaluate now. With no body it behaves like a
// scheduled tick that ignores the master switch. `{ familyId, jobId, force }`
// runs one named job immediately, past the window/reserve/cap gates.
router.post('/run', asyncHandler(async (req, res) => {
  const { familyId = null, jobId = null, force = false } = validateRequest(quotaBurnRunSchema, req.body || {});
  if (force && !familyId) {
    throw new ServerError('force requires a familyId — it bypasses that family\'s quota gates', {
      status: 400, code: 'QUOTA_BURN_FORCE_NEEDS_FAMILY',
    });
  }
  const result = await runQuotaBurnCycle({ trigger: 'manual', familyId, jobId, force });
  res.json({ result });
}));

export default router;
