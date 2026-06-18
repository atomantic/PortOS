/**
 * Workspace Contexts routes (#902)
 *
 * Read-only with respect to user work — save/restore snapshot and reconcile
 * the working context (git branch, in-repo shell sessions, scoped tasks) but
 * never mutate a repo or spawn/attach shells. See services/workspaceContext.js.
 */
import { Router } from 'express';
import * as workspaceContext from '../services/workspaceContext.js';
import { validateRequest, workspaceContextParamsSchema } from '../lib/validation.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// Throws 404 when the app id is unknown — every per-app handler returns null
// in that case, so this collapses the repeated null check.
function assertFound(result, appId) {
  if (result === null) {
    throw new ServerError(`No app with id ${appId}`, { status: 404, code: 'NOT_FOUND' });
  }
  return result;
}

// GET /api/workspace-contexts — project switcher list (one row per active app)
router.get('/', asyncHandler(async (req, res) => {
  res.json({ contexts: await workspaceContext.listContexts() });
}));

// GET /api/workspace-contexts/:appId — live context + last-saved snapshot
router.get('/:appId', asyncHandler(async (req, res) => {
  const { appId } = validateRequest(workspaceContextParamsSchema, req.params);
  res.json(assertFound(await workspaceContext.getContext(appId), appId));
}));

// POST /api/workspace-contexts/:appId/save — snapshot current working context
router.post('/:appId/save', asyncHandler(async (req, res) => {
  const { appId } = validateRequest(workspaceContextParamsSchema, req.params);
  res.json(assertFound(await workspaceContext.saveContext(appId), appId));
}));

// POST /api/workspace-contexts/:appId/restore — reconcile saved vs live
router.post('/:appId/restore', asyncHandler(async (req, res) => {
  const { appId } = validateRequest(workspaceContextParamsSchema, req.params);
  res.json(assertFound(await workspaceContext.restoreContext(appId), appId));
}));

// DELETE /api/workspace-contexts/:appId — drop the saved snapshot
router.delete('/:appId', asyncHandler(async (req, res) => {
  const { appId } = validateRequest(workspaceContextParamsSchema, req.params);
  const deleted = await workspaceContext.deleteContext(appId);
  res.json({ deleted });
}));

export default router;
