/**
 * Quota Burn routes — the install-level burn plan, its live status, and manual
 * runs. One loop for the whole install (see services/quotaBurnRunner.js); the
 * work it dispatches may target any managed app, named per job.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, quotaBurnConfigUpdateSchema, quotaBurnRearmSchema, quotaBurnRunSchema } from '../lib/validation.js';
import { QUOTA_BURN_JOB_CATALOG } from '../lib/quotaBurnConfig.js';
import { QUOTA_BURN_PROMPT_PRESETS } from '../lib/quotaBurnPresets.js';
import { QUEUEABLE_IMAGE_MODES } from '../services/imageGen/modes.js';
import { clearQuotaBurnJobCompletion } from '../services/quotaBurnCompletions.js';
import { saveQuotaBurnConfig } from '../services/quotaBurnStore.js';
import { getQuotaBurnStatus, runQuotaBurnCycle } from '../services/quotaBurnRunner.js';
import { getActiveApps } from '../services/apps.js';
import { listUniverseNames } from '../services/universeBuilder.js';
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

// GET /api/quota-burn/catalog — everything the config form needs to build its
// pickers in one round trip: job types + their param descriptors, the family
// list, and the app/universe/render-backend options those params select from.
router.get('/catalog', asyncHandler(async (_req, res) => {
  const [apps, universes, providers] = await Promise.all([
    getActiveApps(),
    // The `{ id, name }` projection, NOT listUniverses() — the picker needs a
    // label, not every bible on the install. A missing/empty universe store must
    // not 500 the config page either; the universe job just has nothing to pick.
    listUniverseNames().catch(() => []),
    listProviders().catch(() => []),
  ]);
  res.json({
    jobTypes: QUOTA_BURN_JOB_CATALOG,
    // Prompt templates for `agent-prompt` jobs. Served rather than bundled into
    // the client so the wording is one server-side edit — and so a job the user
    // has already tuned is never overwritten by a newer version of the text.
    presets: QUOTA_BURN_PROMPT_PRESETS,
    apps: (apps || []).map((app) => ({ id: app.id, name: app.name })),
    universes,
    // Exactly the modes the media job queue can dispatch — the burn job enqueues
    // through it, so a backend added there appears in this picker for free.
    imageModes: QUEUEABLE_IMAGE_MODES,
    providers: providers || [],
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
