/**
 * Forge credential repair for a managed app.
 *
 *   POST /:id/forge-auth/refresh                  → start `gh auth refresh` for the app's forge host
 *   GET  /:id/forge-auth/refresh/:jobId/events    → SSE: device-code → complete | error | canceled
 *   POST /:id/forge-auth/refresh/:jobId/cancel    → stop it
 *
 * The host is always derived from the app's own origin, never taken from the
 * request. All three are host-control routes (lib/hostControlRoutes.js): the
 * device-code stream matters as much as the start — whoever approves a code
 * decides which account the host's gh token belongs to.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { resolveAppForgeTarget } from '../../lib/workTracker.js';
import { resolveForgeForRepo } from '../../services/forgeAuth.js';
import {
  attachForgeScopeRefreshClient,
  cancelForgeScopeRefresh,
  hasForgeScopeRefresh,
  startForgeScopeRefresh,
} from '../../services/forgeScopeRefresh.js';
import { loadApp } from './shared.js';

const router = Router();

const refreshBodySchema = z.object({
  scopes: z.array(z.string().regex(/^[a-z][a-z0-9:_.-]*$/i)).min(1).max(8),
});
const jobParamsSchema = z.object({ id: z.string().min(1), jobId: z.string().uuid() });

router.post('/:id/forge-auth/refresh', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { scopes } = validateRequest(refreshBodySchema, req.body ?? {});

  const { target } = await resolveAppForgeTarget(app);
  if (!target || target.forge !== 'github') {
    // glab keeps one token per host with no scope refresh; nothing to drive.
    throw new ServerError('Only GitHub hosts can be refreshed from PortOS. For GitLab, update the token with glab auth login.', {
      status: 409,
      code: 'FORGE_REFRESH_UNSUPPORTED',
    });
  }
  const host = (target.webHost || target.apiHost)?.toLowerCase();
  if (!host) throw new ServerError("This app's forge host could not be resolved", { status: 409, code: 'FORGE_REFRESH_UNSUPPORTED' });

  // The account merges actually authenticate as (an owner-match or the app's
  // pin) — `gh auth refresh` only reaches the host's active one.
  const resolved = await resolveForgeForRepo(app.repoPath, { forgeAccount: app.forgeAccount });

  if (!resolved.host) throw new ServerError("This app's forge host could not be resolved", {
    status: 409, code: 'FORGE_REFRESH_UNSUPPORTED',
  });
  if (resolved.host.toLowerCase() !== host) throw new ServerError("This app's forge host changed during account resolution. Retry the refresh.", {
    status: 409, code: 'FORGE_REFRESH_HOST_CHANGED',
  });

  const job = await startForgeScopeRefresh({ host, scopes, expectedAccount: resolved.account || null });
  res.status(job.adopted ? 200 : 202).json(job);
}));

router.get('/:id/forge-auth/refresh/:jobId/events', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(jobParamsSchema, req.params);
  if (!hasForgeScopeRefresh(jobId) || !attachForgeScopeRefreshClient(jobId, res)) {
    throw new ServerError('No such refresh in progress', { status: 404, code: 'NOT_FOUND' });
  }
}));

router.post('/:id/forge-auth/refresh/:jobId/cancel', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(jobParamsSchema, req.params);
  res.json({ canceled: cancelForgeScopeRefresh(jobId) });
}));

export default router;
