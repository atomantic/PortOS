/**
 * Quota Burn routes — the install-level burn plan, its live status, and manual
 * runs. One loop for the whole install (see services/quotaBurnRunner.js); the
 * work it dispatches may target any managed app, named per job.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, quotaBurnConfigUpdateSchema, quotaBurnRearmSchema, quotaBurnRunSchema } from '../lib/validation.js';
import { clearQuotaBurnJobCompletion } from '../services/quotaBurnCompletions.js';
import { convertLegacyQuotaBurnPatch } from '../services/quotaBurnConversion.js';
import { saveQuotaBurnConfig } from '../services/quotaBurnStore.js';
import { getQuotaBurnStatus, runQuotaBurnCycle } from '../services/quotaBurnRunner.js';
import { getActiveApps } from '../services/apps.js';
import { listProviders } from '../services/providers.js';

const router = Router();

// GET /api/quota-burn — plan + live status (quota cards, per-job pending counts,
// why each family would or wouldn't burn, recent runs). `?refresh=1` re-scrapes
// provider usage; the default read is cached so opening the page is free.
router.get('/', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  // getQuotaBurnStatus returns the config it already loaded — reading the file a
  // second time here would just normalize the same bytes twice per page load.
  res.json(await getQuotaBurnStatus({ refresh }));
}));

// GET /api/quota-burn/catalog — what the STEP editor still needs from this
// route: the managed apps a reference may target and the providers a
// per-invocation pin may name. The work itself is no longer here — a step
// references a scheduled task, and those come from the shared schedule/custom-job
// reads the CoS Schedule and System Tasks pages already make. The legacy job-type
// catalog and the prompt presets are deliberately NOT served: they are frozen
// compatibility-and-migration inputs (#6381), and offering them would invite a
// client to author work that no longer has an executor.
router.get('/catalog', asyncHandler(async (_req, res) => {
  const [apps, providers] = await Promise.all([
    getActiveApps(),
    listProviders().catch(() => []),
  ]);
  res.json({
    apps: (apps || []).map((app) => ({ id: app.id, name: app.name })),
    providers: providers || [],
  });
}));

// PUT /api/quota-burn — merge a partial plan. Top-level and per-family keys
// merge; a family's `jobs` array replaces.
router.put('/', asyncHandler(async (req, res) => {
  const patch = validateRequest(quotaBurnConfigUpdateSchema, req.body);
  // An old client may still PUT a legacy `jobType` step. It is converted through
  // the SAME service the migration used before it reaches disk, so a stale body
  // can neither downgrade a reference nor create a second automation beside one
  // that already exists.
  const config = await saveQuotaBurnConfig(await convertLegacyQuotaBurnPatch(patch));
  res.json({ config });
}));

// POST /api/quota-burn/run — evaluate now. With no body it behaves like a
// scheduled tick that ignores the master switch. `{ familyId, jobId, force }`
// runs a family or one named job immediately, past the window/reserve/cap gates.
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

// POST /api/quota-burn/rearm — put spent `run once` steps back into the
// rotation. `{ familyId }` re-arms that family's whole plan; adding `jobId`
// scopes it to one step. Does NOT dispatch anything: the next cycle decides
// that, against the same quota gates as always.
router.post('/rearm', asyncHandler(async (req, res) => {
  const { familyId, jobId = null } = validateRequest(quotaBurnRearmSchema, req.body || {});
  await clearQuotaBurnJobCompletion(familyId, jobId);
  // The fresh status, so the page's job rows drop their "ran once" badges
  // without a second round trip. Cached quota (no `refresh`) — re-arming says
  // nothing about the provider's numbers.
  res.json(await getQuotaBurnStatus());
}));

export default router;
