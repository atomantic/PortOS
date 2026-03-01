import { Router } from 'express';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import * as appsService from '../services/apps.js';
import { notifyAppsChanged, PORTOS_APP_ID } from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import * as appUpdater from '../services/appUpdater.js';
import * as cos from '../services/cos.js';
import { logAction } from '../services/history.js';
import { z } from 'zod';
import { validateRequest, appSchema, appUpdateSchema } from '../lib/validation.js';
import * as git from '../services/git.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { parseEcosystemFromPath } from '../services/streamingDetect.js';

const router = Router();

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
    if ((!processes || processes.length === 0) && existsSync(app.repoPath)) {
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

    return {
      ...app,
      processes,
      uiPort,
      devUiPort,
      apiPort,
      pm2Status: statuses,
      overallStatus
    };
  }));

  res.json(enriched);
}));

// GET /api/apps/:id - Get single app
router.get('/:id', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  // Get PM2 status for each process (using app's custom PM2_HOME if set)
  const statuses = {};
  for (const processName of app.pm2ProcessNames || []) {
    const status = await pm2Service.getAppStatus(processName, app.pm2Home).catch(() => ({ status: 'unknown' }));
    statuses[processName] = status;
  }

  // Compute overall status (same logic as list endpoint)
  const statusValues = Object.values(statuses);
  let overallStatus = 'unknown';
  if (statusValues.some(s => s.status === 'online')) {
    overallStatus = 'online';
  } else if (statusValues.some(s => s.status === 'stopped')) {
    overallStatus = 'stopped';
  } else if (statusValues.every(s => s.status === 'not_found')) {
    overallStatus = 'not_started';
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

  res.json({ ...app, uiPort, devUiPort, apiPort, overallStatus, pm2Status: statuses });
}));

// POST /api/apps - Create new app
router.post('/', asyncHandler(async (req, res, next) => {
  const data = validateRequest(appSchema, req.body);
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

// GET /api/apps/:id/task-types - Get per-app task type overrides
router.get('/:id/task-types', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const overrides = await appsService.getAppTaskTypeOverrides(app.id);
  res.json({ appId: app.id, appName: app.name, taskTypeOverrides: overrides });
}));

// PUT /api/apps/:id/task-types/:taskType - Update a task type override for an app
router.put('/:id/task-types/:taskType', asyncHandler(async (req, res) => {
  const { enabled, interval } = req.body;
  if (typeof enabled !== 'boolean' && interval === undefined) {
    throw new ServerError('enabled (boolean) or interval (string|null) required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Validate interval against allowed values
  if (interval !== undefined) {
    const allowedIntervals = ['rotation', 'daily', 'weekly', 'once', 'on-demand'];
    if (interval !== null && (typeof interval !== 'string' || !allowedIntervals.includes(interval))) {
      throw new ServerError('interval must be one of rotation|daily|weekly|once|on-demand or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }

  const result = await appsService.updateAppTaskTypeOverride(req.params.id, req.params.taskType, { enabled, interval });
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

  const processNames = app.pm2ProcessNames || [app.name.toLowerCase().replace(/\s+/g, '-')];

  // Check if ecosystem config exists - prefer using it for proper env var handling
  const hasEcosystem = ['ecosystem.config.cjs', 'ecosystem.config.js']
    .some(f => existsSync(`${app.repoPath}/${f}`));

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

  if (!app.repoPath || !existsSync(app.repoPath)) {
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

  if (!existsSync(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const buildCommand = app.buildCommand || 'npm run build';
  const [cmd, ...args] = buildCommand.split(/\s+/);

  // Only allow npm/npx as build commands
  if (!['npm', 'npx'].includes(cmd)) {
    throw new ServerError('Build command must start with npm or npx', { status: 400, code: 'INVALID_BUILD_COMMAND' });
  }

  console.log(`🔨 Building ${app.name}: ${buildCommand}`);

  const BUILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const result = await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: app.repoPath, shell: false, windowsHide: true });
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
    child.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code });
      }
    });
    child.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, stderr: err.message, code: -1 });
      }
    });
  });

  await logAction('build', app.id, app.name, { buildCommand }, result.success);
  console.log(`${result.success ? '✅' : '❌'} Build ${result.success ? 'complete' : 'failed'} for ${app.name}`);

  if (!result.success) {
    throw new ServerError(`Build failed: ${result.stderr || `exit code ${result.code}`}`, { status: 500, code: 'BUILD_FAILED' });
  }

  res.json({ success: true, output: result.stdout });
}));

// GET /api/apps/:id/status - Get PM2 status
router.get('/:id/status', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
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
  'studio'     // Android Studio
]);

// POST /api/apps/:id/open-editor - Open app in editor
router.post('/:id/open-editor', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!existsSync(app.repoPath)) {
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

  if (!existsSync(app.repoPath)) {
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

  if (!existsSync(app.repoPath)) {
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

  if (!existsSync(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // Parse ecosystem config from the app's repo path
  const { processes, pm2Home } = await parseEcosystemFromPath(app.repoPath);

  // Update app with new process data
  const updates = {};

  // Update pm2Home if detected and different from current
  if (pm2Home && pm2Home !== app.pm2Home) {
    updates.pm2Home = pm2Home;
  }

  if (processes.length > 0) {
    updates.processes = processes;
    updates.pm2ProcessNames = processes.map(p => p.name);

    // Update apiPort if we found one and it's different
    const processWithPort = processes.find(p => p.port);
    if (processWithPort && processWithPort.port !== app.apiPort) {
      updates.apiPort = processWithPort.port;
    }
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

const ALLOWED_DOCUMENTS = ['PLAN.md', 'CLAUDE.md', 'GOALS.md'];

const documentUpdateSchema = z.object({
  content: z.string().max(500000),
  commitMessage: z.string().max(200).optional()
});

// GET /api/apps/:id/documents - List which documents exist
router.get('/:id/documents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!app.repoPath || !existsSync(app.repoPath)) {
    return res.json({ documents: [], hasPlanning: false });
  }

  const documents = ALLOWED_DOCUMENTS.map(filename => ({
    filename,
    exists: existsSync(join(app.repoPath, filename))
  }));

  const hasPlanning = existsSync(join(app.repoPath, '.planning'));

  // GSD status: detect which GSD artifacts exist
  const planningDir = join(app.repoPath, '.planning');
  const gsd = {
    hasCodebaseMap: existsSync(join(planningDir, 'codebase')),
    hasProject: existsSync(join(planningDir, 'PROJECT.md')),
    hasRoadmap: existsSync(join(planningDir, 'ROADMAP.md')),
    hasState: existsSync(join(planningDir, 'STATE.md')),
    hasConcerns: existsSync(join(planningDir, 'CONCERNS.md')),
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

  if (!app.repoPath || !existsSync(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  // Path traversal guard
  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  if (!existsSync(resolved)) {
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

  if (!app.repoPath || !existsSync(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  const { content, commitMessage } = documentUpdateSchema.parse(req.body);
  const created = !existsSync(resolved);

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
