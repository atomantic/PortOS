/**
 * Harnesses — manage the coding-agent CLIs/TUIs PortOS drives.
 *
 *   GET  /api/harnesses                  → every harness, its version, its providers
 *   POST /api/harnesses/action?runtime=&action=  → SSE stream of install/update/remove
 *   POST /api/harnesses/models/refresh   → re-read a harness's model catalog
 *
 * Backs **Models → Harnesses**. The AI Providers page could already install a
 * missing CLI (`POST /api/providers/runtimes/install`), but there was no way to
 * see which version was installed, update a stale one, remove one, or refresh
 * the model list a harness knows about — which is how an install goes months
 * out of date with nothing in the UI saying so.
 *
 * Every mutating endpoint names a harness *id* from the fixed table in
 * `services/providerRuntimeInstaller.js`; no request value reaches a shell word,
 * and no response carries a resolved filesystem path (a global bin directory
 * embeds the host account name — see the Sensitive Data rules in AGENTS.md).
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, harnessActionSchema, harnessRefreshSchema } from '../lib/validation.js';
import { streamHarnessAction } from '../services/harnessActionStream.js';
import { listHarnesses, refreshHarnessModels } from '../services/harnesses.js';

const router = Router();

/**
 * The whole page in one round trip. `?fresh=1` bypasses both the runtime status
 * TTL and the npm-registry cache — what the page's Refresh button sends, and
 * what it re-reads after every action so a just-installed version shows without
 * waiting out a cache.
 */
router.get('/', asyncHandler(async (req, res) => {
  res.json({ harnesses: await listHarnesses({ fresh: req.query.fresh === '1' }) });
}));

/**
 * Install, update, or remove one harness, streaming the child's output as SSE.
 *
 * A POST because it mutates host state, and the shared `RuntimeInstallModal`
 * already appends `runtime` to the query string for every BYO-runtime
 * installer — `action` rides beside it for the same reason.
 */
router.post('/action', asyncHandler(async (req, res) => {
  const { runtime, action } = validateRequest(harnessActionSchema, {
    runtime: req.query.runtime,
    action: req.query.action,
  });
  await streamHarnessAction(req, res, { runtime, action });
}));

/**
 * Re-read a harness's own model catalog and write it to every provider that
 * draws from it.
 *
 * Refusals here are 409, not 500: "this harness cannot list its models" and
 * "sign in first" are states of the host, not server faults, and the page
 * renders the reason verbatim.
 */
router.post('/models/refresh', asyncHandler(async (req, res) => {
  const { runtime } = validateRequest(harnessRefreshSchema, { runtime: req.query.runtime });
  const result = await refreshHarnessModels(runtime);
  if (!result.ok) {
    throw new ServerError(result.reason, { status: 409, code: 'HARNESS_MODELS_UNAVAILABLE', context: { runtime } });
  }
  res.json(result);
}));

export default router;
