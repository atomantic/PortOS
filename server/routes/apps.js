import { Router } from 'express';
import { spawn } from 'child_process';
import { readFile, writeFile, stat, access, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import * as appsService from '../services/apps.js';
import { notifyAppsChanged, PORTOS_APP_ID } from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import * as appUpdater from '../services/appUpdater.js';
import * as cos from '../services/cos.js';
import { logAction } from '../services/history.js';
import { z } from 'zod';
import { validateRequest, appSchema, appUpdateSchema, sanitizeTaskMetadata } from '../lib/validation.js';
import * as git from '../services/git.js';
import { parseCronToNextRun } from '../services/eventScheduler.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { parseEcosystemFromPath, usesPm2 } from '../services/streamingDetect.js';
import { detectAppIcon, getIconContentType } from '../services/appIconDetect.js';
import { hasDeployScript } from '../services/appDeployer.js';
import { checkScripts, installScripts, XCODE_SCRIPT_NAMES } from '../services/xcodeScripts.js';

const router = Router();

/** Async equivalent of existsSync — returns true if the path is accessible */
const pathExists = (p) => access(p).then(() => true).catch(() => false);

/**
 * Derive uiPort from apiPort when app has dev UI but no dedicated prod UI port
 * (prod UI is served by the API server in these cases).
 */
function deriveUiPort(uiPort, apiPort, devUiPort) {
  if (!uiPort && apiPort && devUiPort) return apiPort;
  return uiPort;
}

/** Read and parse a JSON file, returning null on any failure (missing file, bad JSON, etc.) */
const safeReadJson = (path) => readFile(path, 'utf-8').then(JSON.parse).catch(() => null);

/**
 * Middleware to load app by :id param and attach to req.loadedApp
 * Throws 404 if not found, eliminating repeated null checks across routes
 */
const loadApp = asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);
  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }
  req.loadedApp = app;
  next();
});

// GET /api/apps - List all apps
router.get('/', asyncHandler(async (req, res) => {
  const apps = await appsService.getAllApps();

  // Group apps by their PM2_HOME (null = default)
  const pm2HomeGroups = new Map();
  for (const app of apps) {
    const home = app.pm2Home || null;
    if (!pm2HomeGroups.has(home)) {
      pm2HomeGroups.set(home, []);
    }
    pm2HomeGroups.get(home).push(app);
  }

  // Fetch PM2 processes for each unique PM2_HOME
  const pm2Maps = new Map();
  for (const pm2Home of pm2HomeGroups.keys()) {
    const processes = await pm2Service.listProcesses(pm2Home).catch(() => []);
    pm2Maps.set(pm2Home, new Map(processes.map(p => [p.name, p])));
  }

  // Enrich with PM2 status and auto-populate processes if needed
  const enriched = await Promise.all(apps.map(async (app) => {
    // Non-PM2 apps skip PM2 enrichment entirely
    if (!usesPm2(app.type)) {
      return { ...app, pm2Status: {}, overallStatus: 'n/a', hasDeployScript: hasDeployScript(app), xcodeScripts: checkScripts(app) };
    }

    const pm2Home = app.pm2Home || null;
    const pm2Map = pm2Maps.get(pm2Home) || new Map();

    const statuses = {};
    for (const processName of app.pm2ProcessNames || []) {
      const pm2Proc = pm2Map.get(processName);
      statuses[processName] = pm2Proc ?? { name: processName, status: 'not_found', pm2_env: null };
    }

    // Compute overall status
    const statusValues = Object.values(statuses);
    let overallStatus = 'unknown';
    if (statusValues.some(s => s.status === 'online')) {
      overallStatus = 'online';
    } else if (statusValues.some(s => s.status === 'stopped')) {
      overallStatus = 'stopped';
    } else if (statusValues.every(s => s.status === 'not_found')) {
      overallStatus = 'not_started';
    }

    // Auto-populate processes from ecosystem config if not already set
    let processes = app.processes;
    if ((!processes || processes.length === 0) && await pathExists(app.repoPath)) {
      const parsed = await parseEcosystemFromPath(app.repoPath).catch(() => ({ processes: [] }));
      processes = parsed.processes;
    }

    // Auto-derive uiPort/apiPort/devUiPort from processes when not explicitly set
    let { uiPort, apiPort, devUiPort } = app;
    if (!uiPort && processes?.length) {
      const uiProc = processes.find(p => p.ports?.ui);
      if (uiProc) uiPort = uiProc.ports.ui;
    }
    if (!apiPort && processes?.length) {
      const apiProc = processes.find(p => p.ports?.api);
      if (apiProc) apiPort = apiProc.ports.api;
    }
    if (!devUiPort && processes?.length) {
      const devUiProc = processes.find(p => p.ports?.devUi);
      if (devUiProc) devUiPort = devUiProc.ports.devUi;
    }
    uiPort = deriveUiPort(uiPort, apiPort, devUiPort);

    return {
      ...app,
      processes,
      uiPort,
      devUiPort,
      apiPort,
      pm2Status: statuses,
      overallStatus,
      hasDeployScript: hasDeployScript(app),
      xcodeScripts: checkScripts(app)
    };
  }));

  res.json(enriched);
}));

// GET /api/apps/:id - Get single app
router.get('/:id', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  // Non-PM2 apps skip PM2 status
  let statuses = {};
  let overallStatus = 'n/a';

  if (usesPm2(app.type)) {
    // Get PM2 status for each process (using app's custom PM2_HOME if set)
    for (const processName of app.pm2ProcessNames || []) {
      const status = await pm2Service.getAppStatus(processName, app.pm2Home).catch(() => ({ status: 'unknown' }));
      statuses[processName] = status;
    }

    // Compute overall status (same logic as list endpoint)
    const statusValues = Object.values(statuses);
    overallStatus = 'unknown';
    if (statusValues.some(s => s.status === 'online')) {
      overallStatus = 'online';
    } else if (statusValues.some(s => s.status === 'stopped')) {
      overallStatus = 'stopped';
    } else if (statusValues.every(s => s.status === 'not_found')) {
      overallStatus = 'not_started';
    }
  }

  // Auto-derive uiPort/apiPort/devUiPort from processes when not explicitly set
  let { uiPort, apiPort, devUiPort } = app;
  const processes = app.processes || [];
  if (!uiPort && processes.length) {
    const uiProc = processes.find(p => p.ports?.ui);
    if (uiProc) uiPort = uiProc.ports.ui;
  }
  if (!apiPort && processes.length) {
    const apiProc = processes.find(p => p.ports?.api);
    if (apiProc) apiPort = apiProc.ports.api;
  }
  if (!devUiPort && processes.length) {
    const devUiProc = processes.find(p => p.ports?.devUi);
    if (devUiProc) devUiPort = devUiProc.ports.devUi;
  }
  uiPort = deriveUiPort(uiPort, apiPort, devUiPort);

  // Read version from app's package.json if available
  let appVersion = null;
  if (app.repoPath) {
    const pkg = await safeReadJson(join(app.repoPath, 'package.json'));
    appVersion = pkg?.version || null;
  }

  res.json({ ...app, uiPort, devUiPort, apiPort, overallStatus, pm2Status: statuses, appVersion, hasDeployScript: hasDeployScript(app), xcodeScripts: checkScripts(app) });
}));

// POST /api/apps/:id/xcode-scripts/install - Install missing management scripts
// Restrict the request payload to the known, fixed set of script names so that
// arbitrary or oversized arrays are rejected at the validation layer.
const installScriptsSchema = z.object({
  scripts: z.array(z.enum(XCODE_SCRIPT_NAMES)).min(1).max(XCODE_SCRIPT_NAMES.length)
});
router.post('/:id/xcode-scripts/install', loadApp, asyncHandler(async (req, res) => {
  const { scripts } = validateRequest(installScriptsSchema, req.body);
  if (!req.loadedApp.repoPath || !await pathExists(req.loadedApp.repoPath)) {
    throw new ServerError('App repository path not found', { status: 400, code: 'PATH_NOT_FOUND' });
  }
  const result = await installScripts(req.loadedApp, scripts);
  if (result.errors.length && !result.installed.length) {
    throw new ServerError(result.errors.join(', '), { status: 400, code: 'INSTALL_FAILED' });
  }
  res.json(result);
}));

// POST /api/apps/:id/upgrade-tls - Copy the tailscale-https helper into the target app's
// repo and record tlsPort in apps.json so the Launch button prefers HTTPS. The app still
// needs to be edited manually to call createTailscaleServers() — we return an example
// snippet in the response so the frontend can surface it. Refuse to overwrite an existing
// helper unless `force: true` is set; this way a user who has customized their copy keeps it.
const upgradeTlsSchema = z.object({
  tlsPort: z.number().int().min(1).max(65535),
  force: z.boolean().optional()
});
router.post('/:id/upgrade-tls', loadApp, asyncHandler(async (req, res) => {
  const { tlsPort, force } = validateRequest(upgradeTlsSchema, req.body);
  const app = req.loadedApp;
  if (app.id === PORTOS_APP_ID) {
    throw new ServerError('PortOS itself already uses the helper — nothing to upgrade', {
      status: 400, code: 'ALREADY_UPGRADED'
    });
  }
  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repository path not found', { status: 400, code: 'PATH_NOT_FOUND' });
  }
  const sourcePath = join(PATHS.root, 'lib', 'tailscale-https.js');
  const targetDir = join(app.repoPath, 'lib');
  const targetPath = join(targetDir, 'tailscale-https.js');

  const alreadyExists = await pathExists(targetPath);
  if (alreadyExists && !force) {
    throw new ServerError(
      'A tailscale-https.js already exists in the target app. Pass force:true to overwrite.',
      { status: 409, code: 'ALREADY_EXISTS' }
    );
  }

  const [helperSource] = await Promise.all([
    readFile(sourcePath, 'utf-8'),
    mkdir(targetDir, { recursive: true })
  ]);
  await writeFile(targetPath, helperSource);

  await appsService.updateApp(app.id, { tlsPort });

  const snippet = [
    `// In your server entry, replace the direct http.createServer(app).listen(...) with:`,
    `import { createTailscaleServers, watchCertReload } from './lib/tailscale-https.js';`,
    ``,
    `const CERT_DIR = process.env.CERT_DIR || '/path/to/data/certs'; // shared with PortOS`,
    `const { server, mirror, httpsEnabled } = createTailscaleServers(app, { certDir: CERT_DIR });`,
    `// io.attach(server); if (mirror) io.attach(mirror); // when using Socket.IO`,
    `server.listen(${tlsPort}, '0.0.0.0');`,
    `// Optional: bind the HTTP mirror on a port of your choosing (127.0.0.1 only).`,
    `// if (mirror) mirror.listen(<your-mirror-port>, '127.0.0.1');`,
    `if (httpsEnabled) watchCertReload(server, CERT_DIR);`
  ].join('\n');

  res.json({
    ok: true,
    helperPath: targetPath,
    overwrote: alreadyExists,
    tlsPort,
    snippet,
    certDirHint: join(PATHS.data, 'certs'),
    note: 'Point your app at the PortOS cert dir (or symlink it) so apps share the single Tailscale cert.'
  });
}));

// GET /api/apps/:id/icon - Serve the app's detected icon image
router.get('/:id/icon', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  // Use stored appIconPath, or detect on-the-fly
  let iconPath = app.appIconPath;
  if (!iconPath || !await pathExists(iconPath)) {
    iconPath = await detectAppIcon(app.repoPath, app.type);
    // Persist the detected path for future requests
    if (iconPath && iconPath !== app.appIconPath) {
      await appsService.updateApp(app.id, { appIconPath: iconPath });
    }
  }

  if (!iconPath || !await pathExists(iconPath)) {
    return res.status(404).json({ error: 'No app icon found' });
  }

  const contentType = getIconContentType(iconPath);
  const iconStat = await stat(iconPath).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!iconStat) return res.status(404).json({ error: 'No app icon found' });
  const etag = `W/"${iconStat.mtimeMs.toString(36)}-${iconStat.size.toString(36)}"`;

  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('ETag', etag);
  res.set('X-Content-Type-Options', 'nosniff');
  if (contentType === 'image/svg+xml') {
    res.set('Content-Disposition', 'inline; filename="icon.svg"');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  }

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const tags = ifNoneMatch.split(',').map(v => v.trim());
    if (tags.includes('*') || tags.includes(etag)) {
      return res.status(304).end();
    }
  }

  const iconData = await readFile(iconPath).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!iconData) return res.status(404).json({ error: 'No app icon found' });
  res.send(iconData);
}));

// POST /api/apps - Create new app
router.post('/', asyncHandler(async (req, res, next) => {
  const data = validateRequest(appSchema, req.body);

  // Detect app icon before creation to avoid a double write
  if (data.repoPath) {
    const detectedIcon = await detectAppIcon(data.repoPath, data.type);
    if (detectedIcon) data.appIconPath = detectedIcon;
  }

  const app = await appsService.createApp(data);
  res.status(201).json(app);
}));

// PUT /api/apps/:id - Update app
router.put('/:id', asyncHandler(async (req, res, next) => {
  const data = validateRequest(appUpdateSchema, req.body);
  const app = await appsService.updateApp(req.params.id, data);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(app);
}));

// DELETE /api/apps/:id - Delete app (PortOS baseline cannot be deleted)
router.delete('/:id', asyncHandler(async (req, res, next) => {
  if (req.params.id === PORTOS_APP_ID) {
    throw new ServerError('PortOS baseline app cannot be deleted', { status: 403, code: 'PROTECTED' });
  }

  const deleted = await appsService.deleteApp(req.params.id);

  if (!deleted) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.status(204).send();
}));

// POST /api/apps/:id/archive - Archive app (exclude from COS tasks)
router.post('/:id/archive', asyncHandler(async (req, res) => {
  if (req.params.id === PORTOS_APP_ID) {
    throw new ServerError('PortOS baseline app cannot be archived', { status: 403, code: 'PROTECTED' });
  }

  const app = await appsService.archiveApp(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  console.log(`📦 Archived app: ${app.name}`);
  notifyAppsChanged('archive');
  res.json(app);
}));

// POST /api/apps/:id/unarchive - Unarchive app (include in COS tasks)
router.post('/:id/unarchive', asyncHandler(async (req, res) => {
  const app = await appsService.unarchiveApp(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  console.log(`📤 Unarchived app: ${app.name}`);
  notifyAppsChanged('unarchive');
  res.json(app);
}));

// PUT /api/apps/bulk-task-type/:taskType - Enable/disable a task type for all active apps
router.put('/bulk-task-type/:taskType', asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    throw new ServerError('enabled (boolean) is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await appsService.bulkUpdateAppTaskTypeOverride(req.params.taskType, { enabled });
  console.log(`📋 Bulk ${enabled ? 'enabled' : 'disabled'} task type ${req.params.taskType} for ${result.count} apps`);
  res.json({ success: true, taskType: req.params.taskType, enabled, appsUpdated: result.count });
}));

// POST /api/apps/detect-icons - Detect and persist app icons for all apps
router.post('/detect-icons', asyncHandler(async (req, res) => {
  const apps = await appsService.getAllApps();
  let detected = 0;

  for (const app of apps) {
    if (!app.repoPath || !await pathExists(app.repoPath)) continue;
    // Skip apps that already have a valid icon path
    if (app.appIconPath && await pathExists(app.appIconPath)) continue;

    const iconPath = await detectAppIcon(app.repoPath, app.type);
    if (iconPath) {
      await appsService.updateApp(app.id, { appIconPath: iconPath });
      detected++;
      console.log(`🎨 Detected icon for ${app.name}: ${iconPath.split('/').pop()}`);
    }
  }

  if (detected > 0) notifyAppsChanged('detect-icons');
  console.log(`🎨 Icon detection complete: ${detected}/${apps.length} apps`);
  res.json({ success: true, detected, total: apps.length });
}));

// GET /api/apps/:id/task-types - Get per-app task type overrides
router.get('/:id/task-types', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const overrides = await appsService.getAppTaskTypeOverrides(app.id);
  res.json({ appId: app.id, appName: app.name, taskTypeOverrides: overrides });
}));

// PUT /api/apps/:id/task-types/all - Toggle all task types for an app
router.put('/:id/task-types/all', loadApp, asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const result = await appsService.toggleAllAppTaskTypes(req.params.id, enabled);
  if (!result) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }
  console.log(`📋 ${enabled ? 'Enabled' : 'Disabled'} all task types for ${result.name}`);
  res.json({ success: true, appId: result.id, taskTypeOverrides: result.taskTypeOverrides || {} });
}));

// PUT /api/apps/:id/task-types/:taskType - Update a task type override for an app
router.put('/:id/task-types/:taskType', asyncHandler(async (req, res) => {
  const { enabled, interval, taskMetadata } = req.body;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (typeof enabled !== 'boolean' && interval === undefined && taskMetadata === undefined) {
    throw new ServerError('enabled (boolean), interval (string|null), or taskMetadata (object|null) required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Validate and sanitize taskMetadata to allowed agent-option keys only
  let sanitizedTaskMetadata;
  if (taskMetadata === undefined) {
    sanitizedTaskMetadata = undefined;
  } else if (taskMetadata === null) {
    sanitizedTaskMetadata = null;
  } else {
    if (typeof taskMetadata !== 'object' || Array.isArray(taskMetadata)) {
      throw new ServerError('taskMetadata must be an object or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
    sanitizedTaskMetadata = sanitizeTaskMetadata(taskMetadata);
    if (sanitizedTaskMetadata === null) {
      throw new ServerError('Invalid taskMetadata: unrecognized keys or values', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }

  // Validate interval against allowed values (also accepts 5-field cron expressions)
  if (interval !== undefined) {
    const allowedIntervals = ['rotation', 'daily', 'weekly', 'once', 'on-demand'];
    if (interval !== null && typeof interval === 'string') {
      const isCron = interval.trim().split(/\s+/).length === 5;
      if (!isCron && !allowedIntervals.includes(interval)) {
        throw new ServerError('interval must be one of rotation|daily|weekly|once|on-demand, a cron expression, or null', { status: 400, code: 'VALIDATION_ERROR' });
      }
      if (isCron) {
        // Validate syntax and field ranges (parseCronToNextRun throws on invalid expressions)
        // Note: null return means no match within search window (e.g. leap day) -- not invalid
        parseCronToNextRun(interval, new Date(), 'UTC');
      }
    } else if (interval !== null) {
      throw new ServerError('interval must be a string or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }

  const result = await appsService.updateAppTaskTypeOverride(req.params.id, req.params.taskType, { enabled, interval, taskMetadata: sanitizedTaskMetadata });
  if (!result) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const action = typeof enabled === 'boolean' ? (enabled ? 'Enabled' : 'Disabled') : 'Updated interval for';
  console.log(`📋 ${action} task type ${req.params.taskType} for ${result.name}`);
  res.json({ success: true, appId: result.id, taskType: req.params.taskType, enabled, interval, taskTypeOverrides: result.taskTypeOverrides || {} });
}));

// POST /api/apps/:id/start - Start app via PM2
router.post('/:id/start', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    throw new ServerError(`${app.type} apps cannot be started via PM2`, { status: 400, code: 'NOT_PM2_APP' });
  }

  const processNames = app.pm2ProcessNames || [app.name.toLowerCase().replace(/\s+/g, '-')];

  // Check if ecosystem config exists - prefer using it for proper env var handling
  const ecosystemChecks = await Promise.all(
    ['ecosystem.config.cjs', 'ecosystem.config.js'].map(f => pathExists(`${app.repoPath}/${f}`))
  );
  const hasEcosystem = ecosystemChecks.some(Boolean);

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
      const result = await pm2Service.startWithCommand(name, app.repoPath, command)
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
    }, 500);
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

  const buildCommand = app.buildCommand || 'npm run build';
  const [cmd, ...args] = buildCommand.split(/\s+/);

  if (!ALLOWED_BUILD_CMDS.has(cmd)) {
    throw new ServerError(`Build command '${cmd}' is not allowed. Allowed: ${[...ALLOWED_BUILD_CMDS].join(', ')}`, { status: 400, code: 'INVALID_BUILD_COMMAND' });
  }

  console.log(`🔨 Building ${app.name}: ${buildCommand}`);

  // Install dependencies before building (root + common subdirs) - skip for non-Node apps
  // For self-builds, skip server/ install to avoid triggering PM2 watch restart
  const isNodeApp = ['npm', 'npx'].includes(cmd);
  const isSelfBuild = app.id === 'portos-default';
  const installDirs = isNodeApp ? ['', 'client', ...(isSelfBuild ? [] : ['server']), 'admin'] : [];
  for (const sub of installDirs) {
    const subDir = sub ? join(app.repoPath, sub) : app.repoPath;
    if (await pathExists(join(subDir, 'package.json'))) {
      const label = sub || 'root';
      console.log(`📦 Installing ${label} dependencies for ${app.name}`);
      const INSTALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
      const installResult = await new Promise((resolve) => {
        const child = spawn(resolveCmd('npm'), ['install'], { cwd: subDir, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const MAX = 16 * 1024;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; child.kill('SIGTERM'); resolve({ success: false, exitCode: -1, output: `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s` }); }
        }, INSTALL_TIMEOUT_MS);
        child.stdout.on('data', d => { if (stdout.length < MAX) stdout += d; });
        child.stderr.on('data', d => { if (stderr.length < MAX) stderr += d; });
        child.on('close', exitCode => { if (!settled) { settled = true; clearTimeout(timer); resolve({ success: exitCode === 0, exitCode, output: (stderr.trim() || stdout.trim()).slice(0, 1024) }); } });
        child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); resolve({ success: false, exitCode: -1, output: err.message }); } });
      });
      if (!installResult.success) {
        console.log(`❌ npm install (${label}) exit=${installResult.exitCode}: ${installResult.output.slice(0, 300)}`);
        await logAction('build', app.id, app.name, { buildCommand, step: `npm install (${label})` }, false);
        throw new ServerError(`npm install failed (${label}) exit=${installResult.exitCode}: ${installResult.output}`, { status: 500, code: 'INSTALL_FAILED' });
      }
    }
  }

  const BUILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const result = await new Promise((resolve) => {
    const child = spawn(resolveCmd(cmd), args, { cwd: app.repoPath, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const MAX = 64 * 1024;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({ success: false, stderr: `Build timed out after ${BUILD_TIMEOUT_MS / 1000}s`, code: -1 });
      }
    }, BUILD_TIMEOUT_MS);
    child.stdout.on('data', d => {
      stdout += d;
      if (stdout.length > MAX) stdout = stdout.slice(-MAX);
    });
    child.stderr.on('data', d => {
      stderr += d;
      if (stderr.length > MAX) stderr = stderr.slice(-MAX);
    });
    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const output = (stderr.trim() || stdout.trim()).slice(0, 1024);
        resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code, signal, output });
      }
    });
    child.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, stderr: err.message, code: -1, signal: null, output: err.message });
      }
    });
  });

  await logAction('build', app.id, app.name, { buildCommand }, result.success);
  console.log(`${result.success ? '✅' : '❌'} Build ${result.success ? 'complete' : 'failed'} for ${app.name}`);

  if (!result.success) {
    const detail = result.signal ? `killed by ${result.signal}` : result.output || `exit code ${result.code}`;
    throw new ServerError(`Build failed: ${detail}`, { status: 500, code: 'BUILD_FAILED' });
  }

  res.json({ success: true, output: result.stdout });
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

// Allowlist of safe build commands
const ALLOWED_BUILD_CMDS = new Set([
  'npm',        // Node.js
  'npx',        // Node.js
  'xcodebuild', // Xcode
  'swift',      // Swift Package Manager
  'make',       // Make
  'cargo'       // Rust
]);

// On Windows, Node-based CLI tools resolve to .cmd shims
const WIN_CMD_SHIMS = new Set(['npm', 'npx']);
const resolveCmd = (cmd) => process.platform === 'win32' && WIN_CMD_SHIMS.has(cmd) ? `${cmd}.cmd` : cmd;

// Allowlist of safe editor commands
// Security: Only allow known-safe editor commands to prevent arbitrary code execution
const ALLOWED_EDITORS = new Set([
  'code',      // VS Code
  'cursor',    // Cursor
  'zed',       // Zed
  'subl',      // Sublime Text
  'atom',      // Atom
  'vim',       // Vim
  'nvim',      // Neovim
  'nano',      // Nano
  'emacs',     // Emacs
  'idea',      // IntelliJ IDEA
  'pycharm',   // PyCharm
  'webstorm',  // WebStorm
  'phpstorm',  // PhpStorm
  'rubymine',  // RubyMine
  'goland',    // GoLand
  'clion',     // CLion
  'rider',     // Rider
  'studio',    // Android Studio
  'xed'        // Xcode
]);

// POST /api/apps/:id/open-editor - Open app in editor
router.post('/:id/open-editor', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const editorCommand = app.editorCommand || 'code .';
  const [cmd, ...args] = editorCommand.split(/\s+/);

  // Security: Validate that the editor command is in our allowlist
  // This prevents arbitrary command execution via malicious editorCommand values
  if (!ALLOWED_EDITORS.has(cmd)) {
    throw new ServerError(`Editor '${cmd}' is not in the allowed editors list`, {
      status: 400,
      code: 'INVALID_EDITOR',
      context: { allowedEditors: Array.from(ALLOWED_EDITORS) }
    });
  }

  // Security: Validate args don't contain shell metacharacters
  const DANGEROUS_CHARS = /[;|&`$(){}[\]<>\\!#*?~]/;
  for (const arg of args) {
    if (DANGEROUS_CHARS.test(arg)) {
      throw new ServerError('Editor arguments contain disallowed characters', {
        status: 400,
        code: 'INVALID_EDITOR_ARGS'
      });
    }
  }

  // Spawn the editor process detached so it doesn't block
  const child = spawn(cmd, args, {
    cwd: app.repoPath,
    detached: true,
    stdio: 'ignore',
    shell: false,  // Security: Ensure no shell interpretation
    windowsHide: true
  });
  child.unref();

  res.json({ success: true, command: editorCommand, path: app.repoPath });
}));

// POST /api/apps/:id/open-claude - Open Claude Code in app directory
router.post('/:id/open-claude', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const child = spawn('claude', [], {
    cwd: app.repoPath,
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true
  });
  child.unref();

  console.log(`🤖 Opened Claude Code in ${app.name}`);
  res.json({ success: true, path: app.repoPath });
}));

// POST /api/apps/:id/open-folder - Open app folder in file manager
router.post('/:id/open-folder', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // Cross-platform folder open command
  const platform = process.platform;
  let cmd, args;

  if (platform === 'darwin') {
    cmd = 'open';
    args = [app.repoPath];
  } else if (platform === 'win32') {
    cmd = 'explorer';
    args = [app.repoPath];
  } else {
    cmd = 'xdg-open';
    args = [app.repoPath];
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  res.json({ success: true, path: app.repoPath });
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
    const pkgContent = await readFile(pkgPath, 'utf-8').catch(() => null);
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

  // Detect app icon if not already set
  if (!app.appIconPath || !await pathExists(app.appIconPath)) {
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

// ============================================================
// Document Endpoints
// ============================================================

const ALLOWED_DOCUMENTS = ['PLAN.md', 'DONE.md', 'CLAUDE.md', 'GOALS.md', 'REVIEW.md', 'REJECTED.md'];

const documentUpdateSchema = z.object({
  content: z.string().max(500000),
  commitMessage: z.string().max(200).optional()
});

// GET /api/apps/:id/documents - List which documents exist
router.get('/:id/documents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    return res.json({ documents: [], hasPlanning: false });
  }

  const documents = await Promise.all(ALLOWED_DOCUMENTS.map(async filename => ({
    filename,
    exists: await pathExists(join(app.repoPath, filename))
  })));

  const planningDir = join(app.repoPath, '.planning');
  const hasPlanning = await pathExists(planningDir);

  // GSD status: detect which GSD artifacts exist
  const gsd = {
    hasCodebaseMap: await pathExists(join(planningDir, 'codebase')),
    hasProject: await pathExists(join(planningDir, 'PROJECT.md')),
    hasRoadmap: await pathExists(join(planningDir, 'ROADMAP.md')),
    hasState: await pathExists(join(planningDir, 'STATE.md')),
    hasConcerns: await pathExists(join(planningDir, 'CONCERNS.md')),
  };

  res.json({ documents, hasPlanning, gsd });
}));

// GET /api/apps/:id/documents/:filename - Read a single document
router.get('/:id/documents/:filename', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { filename } = req.params;

  if (!ALLOWED_DOCUMENTS.includes(filename)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' });
  }

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  // Path traversal guard
  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  if (!await pathExists(resolved)) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }

  const content = await readFile(resolved, 'utf-8');
  res.json({ filename, content });
}));

// PUT /api/apps/:id/documents/:filename - Update a document and git commit
router.put('/:id/documents/:filename', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { filename } = req.params;

  if (!ALLOWED_DOCUMENTS.includes(filename)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' });
  }

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  const { content, commitMessage } = documentUpdateSchema.parse(req.body);
  const created = !await pathExists(resolved);

  await writeFile(resolved, content, 'utf-8');
  await git.stageFiles(app.repoPath, [filename]);

  const status = await git.getStatus(app.repoPath);
  if (status.clean) {
    return res.json({ success: true, noChanges: true });
  }

  const message = commitMessage || `docs: update ${filename} via PortOS`;
  const result = await git.commit(app.repoPath, message);
  console.log(`📝 ${created ? 'Created' : 'Updated'} ${filename} in ${app.name} (${result.hash})`);

  res.json({ success: true, hash: result.hash, created });
}));

// ============================================================
// Agent History Endpoints
// ============================================================

// GET /api/apps/:id/agents - Recent CoS agents for this app
router.get('/:id/agents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const limit = parseInt(req.query.limit, 10) || 50;

  // Get running agents filtered by this app
  const runningAgents = await cos.getAgents().catch(() => []);
  const appRunning = runningAgents.filter(a =>
    a.metadata?.app === app.id || a.metadata?.taskApp === app.id
  );

  // Scan last 14 days of agent history for this app
  const dates = await cos.getAgentDates().catch(() => []);
  const recentDates = dates.slice(0, 14);
  const historyAgents = [];

  for (const { date } of recentDates) {
    if (historyAgents.length >= limit) break;
    const dayAgents = await cos.getAgentsByDate(date).catch(() => []);
    const appAgents = dayAgents.filter(a =>
      a.metadata?.app === app.id || a.metadata?.taskApp === app.id
    );
    historyAgents.push(...appAgents);
  }

  // Combine running + history, deduplicate by id, limit
  const seenIds = new Set();
  const combined = [];
  for (const agent of [...appRunning, ...historyAgents]) {
    if (seenIds.has(agent.id)) continue;
    seenIds.add(agent.id);
    combined.push(agent);
    if (combined.length >= limit) break;
  }

  const running = combined.filter(a => a.status === 'running' || a.status === 'spawning').length;
  const succeeded = combined.filter(a => a.status === 'completed').length;
  const failed = combined.filter(a => a.status === 'failed' || a.status === 'error').length;

  res.json({
    agents: combined,
    summary: { total: combined.length, running, succeeded, failed }
  });
}));

export default router;
