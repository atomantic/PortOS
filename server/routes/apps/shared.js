/**
 * Shared plumbing for the apps sub-routers: the `loadApp` param middleware and
 * the async `pathExists` guard.
 *
 * The pure port/status-derivation helpers (`deriveUiPort`, `deriveAppPorts`,
 * `computeOverallStatus`) and the list enrichment now live in the
 * `appListEnrichment` service; they are re-exported here so existing route
 * imports (`crud.js`, `lifecycle.js`) keep a single import surface.
 *
 * Mirrors the pipeline sub-router `shared.js` pattern — one small module of
 * common plumbing that every domain router imports, so the split preserves a
 * single `loadApp` / error / enrichment behavior across all of `/api/apps`.
 */

import { access } from 'fs/promises';
import * as appsService from '../../services/apps.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';

export { deriveUiPort, deriveAppPorts, computeOverallStatus } from '../../services/appListEnrichment.js';

/** Async equivalent of existsSync — returns true if the path is accessible */
export const pathExists = (p) => access(p).then(() => true).catch(() => false);

/**
 * Middleware to load app by :id param and attach to req.loadedApp.
 * Throws 404 if not found, eliminating repeated null checks across routes.
 */
export const loadApp = asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);
  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }
  req.loadedApp = app;
  next();
});
