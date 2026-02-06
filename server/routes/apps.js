import { Router } from 'express';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as appsService from '../services/apps.js';
import { notifyAppsChanged } from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import { logAction } from '../services/history.js';
import { validate, appSchema, appUpdateSchema } from '../lib/validation.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { parseEcosystemFromPath } from '../services/streamingDetect.js';

const router = Router();

// GET /api/apps - List all apps
router.get('/', asyncHandler(async (req, res) => {
  const apps = await appsService.getAllApps();

  // Get all PM2 processes once
  const allPm2 = await pm2Service.listProcesses().catch(() => []);
  const pm2Map = new Map(allPm2.map(p => [p.name, p]));

  // Enrich with PM2 status and auto-populate processes if needed
  const enriched = await Promise.all(apps.map(async (app) => {
    const statuses = {};
    for (const processName of app.pm2ProcessNames || []) {
      const pm2Proc = pm2Map.get(processName);
      statuses[processName] = pm2Proc || { name: processName, status: 'not_found', pm2_env: null };
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
      processes = await parseEcosystemFromPath(app.repoPath).catch(() => []);
    }

    return {
      ...app,
      processes,
      pm2Status: statuses,
      overallStatus
    };
  }));

  res.json(enriched);
}));

// GET /api/apps/:id - Get single app
router.get('/:id', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  // Get PM2 status for each process
  const statuses = {};
  for (const processName of app.pm2ProcessNames || []) {
    const status = await pm2Service.getAppStatus(processName).catch(() => ({ status: 'unknown' }));
    statuses[processName] = status;
  }

  res.json({ ...app, pm2Status: statuses });
}));

// POST /api/apps - Create new app
router.post('/', asyncHandler(async (req, res, next) => {
  const validation = validate(appSchema, req.body);

  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const app = await appsService.createApp(validation.data);
  res.status(201).json(app);
}));

// PUT /api/apps/:id - Update app
router.put('/:id', asyncHandler(async (req, res, next) => {
  const validation = validate(appUpdateSchema, req.body);

  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const app = await appsService.updateApp(req.params.id, validation.data);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(app);
}));

// DELETE /api/apps/:id - Delete app
router.delete('/:id', asyncHandler(async (req, res, next) => {
  const deleted = await appsService.deleteApp(req.params.id);

  if (!deleted) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.status(204).send();
}));

// POST /api/apps/:id/archive - Archive app (exclude from COS tasks)
router.post('/:id/archive', asyncHandler(async (req, res) => {
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

// POST /api/apps/:id/start - Start app via PM2
router.post('/:id/start', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const processNames = app.pm2ProcessNames || [app.name.toLowerCase().replace(/\s+/g, '-')];

  // Check if ecosystem config exists - prefer using it for proper env var handling
  const hasEcosystem = ['ecosystem.config.cjs', 'ecosystem.config.js']
    .some(f => existsSync(`${app.repoPath}/${f}`));

  let results = {};

  if (hasEcosystem) {
    // Use ecosystem config for proper env/port configuration
    const result = await pm2Service.startFromEcosystem(app.repoPath, processNames)
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
router.post('/:id/stop', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.stopApp(name)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('stop', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);
  notifyAppsChanged('stop');

  res.json({ success: true, results });
}));

// POST /api/apps/:id/restart - Restart app
router.post('/:id/restart', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.restartApp(name)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('restart', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);
  notifyAppsChanged('restart');

  res.json({ success: true, results });
}));

// GET /api/apps/:id/status - Get PM2 status
router.get('/:id/status', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const statuses = {};

  for (const name of app.pm2ProcessNames || []) {
    const status = await pm2Service.getAppStatus(name)
      .catch(err => ({ status: 'error', error: err.message }));
    statuses[name] = status;
  }

  res.json(statuses);
}));

// GET /api/apps/:id/logs - Get logs
router.get('/:id/logs', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const lines = parseInt(req.query.lines) || 100;
  const processName = req.query.process || app.pm2ProcessNames?.[0];

  if (!processName) {
    throw new ServerError('No process name specified', { status: 400, code: 'MISSING_PROCESS' });
  }

  const logs = await pm2Service.getLogs(processName, lines)
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
router.post('/:id/open-editor', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

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
    shell: false  // Security: Ensure no shell interpretation
  });
  child.unref();

  res.json({ success: true, command: editorCommand, path: app.repoPath });
}));

// POST /api/apps/:id/open-folder - Open app folder in file manager
router.post('/:id/open-folder', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

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
    stdio: 'ignore'
  });
  child.unref();

  res.json({ success: true, path: app.repoPath });
}));

// POST /api/apps/:id/refresh-config - Re-parse ecosystem config for PM2 processes
router.post('/:id/refresh-config', asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (!existsSync(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // Parse ecosystem config from the app's repo path
  const processes = await parseEcosystemFromPath(app.repoPath);

  // Update app with new process data
  const updates = {};

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

export default router;
