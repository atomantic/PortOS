/**
 * App runtime lifecycle: PM2 start/stop/restart, update, build, status, logs,
 * and ecosystem-config refresh.
 *
 *   POST /:id/start          → { success, results }
 *   POST /:id/stop           → { success, results }
 *   POST /:id/restart        → { success, results }  (self-restart for PortOS)
 *   POST /:id/update         → { success, steps, progress }
 *   POST /:id/build          → { success, output }
 *   GET  /:id/status         → { [process]: status }
 *   GET  /:id/logs           → { processName, lines, logs }
 *   POST /:id/refresh-config → { success, updated, app, processes }
 */

import { Router } from 'express';
import { join, extname } from 'path';
import { tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import * as appsService from '../../services/apps.js';
import { notifyAppsChanged, PORTOS_APP_ID } from '../../services/apps.js';
import * as pm2Service from '../../services/pm2.js';
import * as appUpdater from '../../services/appUpdater.js';
import * as appBuilder from '../../services/appBuilder.js';
import { logAction } from '../../services/history.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { parseEcosystemFromPath, usesPm2, isDesktopType } from '../../services/streamingDetect.js';
import { detectAppIcon, isUsableSvg } from '../../services/appIconDetect.js';
import { loadApp, pathExists, deriveUiPort } from './shared.js';

const router = Router();

// Delay before restarting PortOS itself so the JSON response reaches the client
const SELF_RESTART_RESPONSE_DELAY_MS = 500;

// POST /api/apps/:id/start - Start app via PM2
router.post('/:id/start', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    throw new ServerError(`${app.type} apps cannot be started via PM2`, { status: 400, code: 'NOT_PM2_APP' });
  }

  const processNames = app.pm2ProcessNames || [app.name.toLowerCase().replace(/\s+/g, '-')];

  // Desktop/GUI apps (a game window) are driven from their own startCommands with
  // autorestart OFF — never wrapped in a web-server ecosystem config. A window
  // closing is a normal exit, and relaunching it would loop forever.
  const desktop = isDesktopType(app.type);

  // Check if ecosystem config exists - prefer using it for proper env var handling.
  // A desktop app is command-launched even if the repo also ships an ecosystem
  // config for its (unrelated) web processes.
  const ecosystemChecks = await Promise.all(
    ['ecosystem.config.cjs', 'ecosystem.config.js'].map(f => pathExists(`${app.repoPath}/${f}`))
  );
  const hasEcosystem = !desktop && ecosystemChecks.some(Boolean);

  let results = {};

  if (hasEcosystem) {
    // Use ecosystem config for proper env/port configuration
    // Pass custom PM2_HOME if the app has one
    const result = await pm2Service.startFromEcosystem(app.repoPath, processNames, app.pm2Home)
      .catch(err => ({ success: false, error: err.message }));
    // Map result to each process name for consistent response format
    for (const name of processNames) {
      results[name] = result;
    }
  } else {
    // Fallback to command-based start for apps without ecosystem config
    const commands = app.startCommands || ['npm run dev'];
    for (let i = 0; i < processNames.length; i++) {
      const name = processNames[i];
      const command = commands[i] || commands[0];
      // Single instance: a desktop/GUI process that is already up — or in the
      // transient `launching` state a slow game build sits in — must not be
      // relaunched into a second window. Matching more than the steady `online`
      // is what stops a click during a slow launch from spawning a duplicate.
      if (desktop) {
        const current = await pm2Service.getAppStatus(name, app.pm2Home).catch(() => null);
        if (['online', 'launching'].includes(current?.status)) {
          results[name] = { success: true, alreadyRunning: true };
          continue;
        }
      }
      const result = await pm2Service.startWithCommand(name, app.repoPath, command, desktop ? { autorestart: false } : {})
        .catch(err => ({ success: false, error: err.message }));
      results[name] = result;
    }
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('start', app.id, app.name, { processNames }, allSuccess);
  notifyAppsChanged('start');

  res.json({ success: true, results });
}));

// POST /api/apps/:id/stop - Stop app
router.post('/:id/stop', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    throw new ServerError(`${app.type} apps cannot be stopped via PM2`, { status: 400, code: 'NOT_PM2_APP' });
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.stopApp(name, app.pm2Home)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('stop', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);
  notifyAppsChanged('stop');

  res.json({ success: true, results });
}));

// POST /api/apps/:id/restart - Restart app
router.post('/:id/restart', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    throw new ServerError(`${app.type} apps cannot be restarted via PM2`, { status: 400, code: 'NOT_PM2_APP' });
  }

  // Self-restart: respond first, then restart after a delay so the response reaches the client
  if (app.id === PORTOS_APP_ID) {
    await logAction('restart', app.id, app.name, { processNames: app.pm2ProcessNames }, true);
    notifyAppsChanged('restart');
    res.json({ success: true, selfRestart: true });
    setTimeout(async () => {
      console.log('🔄 Self-restart: restarting PortOS processes');
      for (const name of app.pm2ProcessNames || []) {
        await pm2Service.restartApp(name, app.pm2Home)
          .catch(err => console.error(`❌ Self-restart failed for ${name}: ${err.message}`));
      }
    }, SELF_RESTART_RESPONSE_DELAY_MS);
    return;
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.restartApp(name, app.pm2Home)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('restart', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);
  notifyAppsChanged('restart');

  res.json({ success: true, results });
}));

// POST /api/apps/:id/update - Pull, install deps, setup, restart
router.post('/:id/update', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  console.log(`⬇️ Starting update for ${app.name}`);
  const progressSteps = [];
  const emit = (step, status, message) => {
    progressSteps.push({ step, status, message, timestamp: Date.now() });
  };

  const result = await appUpdater.updateApp(app, emit);
  const success = result.success;
  await logAction('update', app.id, app.name, { steps: result.steps }, success);
  notifyAppsChanged('update');
  console.log(`${success ? '✅' : '❌'} Update ${success ? 'complete' : 'failed'} for ${app.name}`);

  res.json({ success, steps: result.steps, progress: progressSteps });
}));

// POST /api/apps/:id/build - Build production UI
router.post('/:id/build', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const result = await appBuilder.buildApp(app);

  if (result.failure === 'validation') {
    throw new ServerError(result.message, { status: 400, code: result.code });
  }

  if (result.failure === 'install') {
    await logAction('build', app.id, app.name, { buildCommand: result.buildCommand, step: `npm install (${result.label})` }, false);
    throw new ServerError(`npm install failed (${result.label}) exit=${result.exitCode}: ${result.output}`, { status: 500, code: 'INSTALL_FAILED' });
  }

  await logAction('build', app.id, app.name, { buildCommand: result.buildCommand }, result.success);

  if (!result.success) {
    const detail = result.signal ? `killed by ${result.signal}` : result.output || `exit code ${result.code}`;
    throw new ServerError(`Build failed: ${detail}`, { status: 500, code: 'BUILD_FAILED' });
  }

  res.json({ success: true, output: result.output });
}));

// GET /api/apps/:id/status - Get PM2 status
router.get('/:id/status', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    return res.json({});
  }

  const statuses = {};

  for (const name of app.pm2ProcessNames || []) {
    const status = await pm2Service.getAppStatus(name, app.pm2Home)
      .catch(err => ({ status: 'error', error: err.message }));
    statuses[name] = status;
  }

  res.json(statuses);
}));

// GET /api/apps/:id/logs - Get logs
router.get('/:id/logs', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const lines = parseInt(req.query.lines, 10) || 100;
  const processName = req.query.process || app.pm2ProcessNames?.[0];

  if (!processName) {
    throw new ServerError('No process name specified', { status: 400, code: 'MISSING_PROCESS' });
  }

  const logs = await pm2Service.getLogs(processName, lines, app.pm2Home)
    .catch(err => `Error retrieving logs: ${err.message}`);

  res.json({ processName, lines, logs });
}));

// POST /api/apps/:id/refresh-config - Re-parse ecosystem config for PM2 processes
router.post('/:id/refresh-config', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    return res.json({ success: true, updated: false, app, processes: [] });
  }

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // Parse ecosystem config from the app's repo path
  const { processes, pm2Home } = await parseEcosystemFromPath(app.repoPath);

  // Update app with new process data
  const updates = {};

  // Detect buildCommand from package.json if not already set
  if (!app.buildCommand) {
    const pkgPath = join(app.repoPath, 'package.json');
    const pkgContent = await tryReadFile(pkgPath);
    if (pkgContent) {
      const pkg = safeJSONParse(pkgContent);
      if (pkg?.scripts?.build) updates.buildCommand = 'npm run build';
    }
  }

  // Update pm2Home if detected and different from current
  if (pm2Home && pm2Home !== app.pm2Home) {
    updates.pm2Home = pm2Home;
  }

  if (processes.length > 0) {
    updates.processes = processes;
    updates.pm2ProcessNames = processes.map(p => p.name);

    // Derive ports from parsed process labels (same logic as streamDetection)
    const apiProc = processes.find(p => p.ports?.api);
    if (apiProc) updates.apiPort = apiProc.ports.api;

    const uiProc = processes.find(p => p.ports?.ui);
    if (uiProc) updates.uiPort = uiProc.ports.ui;

    const devUiProc = processes.find(p => p.ports?.devUi);
    if (devUiProc) updates.devUiPort = devUiProc.ports.devUi;

    updates.uiPort = deriveUiPort(updates.uiPort, updates.apiPort, updates.devUiPort || app.devUiPort);
  }

  // Detect app icon if not already set, missing on disk, or stored as an
  // unusable external-image SVG (won't render under the icon route's CSP).
  const iconStale =
    !app.appIconPath ||
    !await pathExists(app.appIconPath) ||
    (extname(app.appIconPath).toLowerCase() === '.svg' && !await isUsableSvg(app.appIconPath));
  if (iconStale) {
    const detectedIcon = await detectAppIcon(app.repoPath, app.type);
    if (detectedIcon) updates.appIconPath = detectedIcon;
  }

  // Only update if we have changes
  if (Object.keys(updates).length > 0) {
    const updatedApp = await appsService.updateApp(req.params.id, updates);
    console.log(`🔄 Refreshed config for ${app.name}: ${processes.length} processes found`);
    res.json({ success: true, updated: true, app: updatedApp, processes });
  } else {
    console.log(`🔄 No config changes for ${app.name}`);
    res.json({ success: true, updated: false, app, processes: app.processes || [] });
  }
}));

export default router;
