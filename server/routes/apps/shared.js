/**
 * Shared plumbing for the apps sub-routers: the `loadApp` param middleware,
 * the async `pathExists` guard, and the pure port/status-derivation helpers
 * used by both the list (`GET /`) and detail (`GET /:id`) endpoints.
 *
 * Mirrors the pipeline sub-router `shared.js` pattern — one small module of
 * common plumbing that every domain router imports, so the split preserves a
 * single `loadApp` / error / enrichment behavior across all of `/api/apps`.
 */

import { access } from 'fs/promises';
import * as appsService from '../../services/apps.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';

/** Async equivalent of existsSync — returns true if the path is accessible */
export const pathExists = (p) => access(p).then(() => true).catch(() => false);

/**
 * Derive uiPort from apiPort when app has dev UI but no dedicated prod UI port
 * (prod UI is served by the API server in these cases).
 */
export function deriveUiPort(uiPort, apiPort, devUiPort) {
  if (!uiPort && apiPort && devUiPort) return apiPort;
  return uiPort;
}

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

/**
 * Derive uiPort/apiPort/devUiPort from an app's process list when not
 * explicitly set on the app record. Shared by the list and detail endpoints so
 * the two never diverge. Returns the resolved trio (uiPort passed through
 * deriveUiPort for the served-by-API case).
 */
export function deriveAppPorts(app, processes) {
  let { uiPort, apiPort, devUiPort } = app;
  const procs = processes || [];
  if (!uiPort && procs.length) {
    const uiProc = procs.find(p => p.ports?.ui);
    if (uiProc) uiPort = uiProc.ports.ui;
  }
  if (!apiPort && procs.length) {
    const apiProc = procs.find(p => p.ports?.api);
    if (apiProc) apiPort = apiProc.ports.api;
  }
  if (!devUiPort && procs.length) {
    const devUiProc = procs.find(p => p.ports?.devUi);
    if (devUiProc) devUiPort = devUiProc.ports.devUi;
  }
  uiPort = deriveUiPort(uiPort, apiPort, devUiPort);
  return { uiPort, apiPort, devUiPort };
}

/**
 * Compute the overall status from a set of per-process PM2 statuses. A degraded
 * (failed-read) home short-circuits to `unknown` rather than collapsing to a
 * confident `not_started`. Shared by the list and detail endpoints.
 */
export function computeOverallStatus(statusValues, degraded) {
  // Mirrors the original inline logic exactly: an empty status set (an app with
  // no PM2 process names) satisfies the vacuous `every(...)` and resolves to
  // `not_started`, NOT `unknown`.
  if (degraded) return 'unknown';
  if (statusValues.some(s => s.status === 'online')) return 'online';
  if (statusValues.some(s => s.status === 'stopped')) return 'stopped';
  if (statusValues.every(s => s.status === 'not_found')) return 'not_started';
  return 'unknown';
}
