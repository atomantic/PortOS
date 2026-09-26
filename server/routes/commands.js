import { Router } from 'express';
import { processActionSchema, processListQuerySchema, validateRequest } from '../lib/validation.js';
import { validateCommand } from '../lib/commandSecurity.js';
import { existsSync, statSync, realpathSync } from 'fs';
import { resolve } from 'path';
import * as commands from '../services/commands.js';
import { requireHostControl } from '../services/authGate.js';
import * as pm2Service from '../services/pm2.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { isWithinAllowedRoots, outsideAllowedRootsMessage } from '../lib/workspaceRoots.js';

const router = Router();

// POST /api/commands/execute - Execute a command
router.post('/execute', requireHostControl, asyncHandler(async (req, res) => {
  const { command, workspacePath } = req.body;

  if (!command) {
    throw new ServerError('Command is required', { status: 400, code: 'MISSING_COMMAND' });
  }

  // Validate workspacePath if provided: must exist, be a directory, and — after
  // symlinks are followed — resolve within an allowed root. Using realpath here
  // prevents a symlink like /tmp/escape -> /etc from tricking the containment
  // check (which only sees /tmp/escape).
  if (workspacePath !== undefined && workspacePath !== null && workspacePath !== '') {
    if (typeof workspacePath !== 'string') {
      throw new ServerError('workspacePath must be a string', { status: 400, code: 'INVALID_PATH' });
    }
    const resolvedPath = resolve(workspacePath);
    if (!existsSync(resolvedPath)) {
      throw new ServerError('workspacePath does not exist', { status: 400, code: 'INVALID_PATH' });
    }
    // statSync/realpathSync can throw on permission/symlink edge cases — convert
    // those into clean 400s rather than leaking as 500 via centralized middleware.
    let realPath;
    try {
      if (!statSync(resolvedPath).isDirectory()) {
        throw new ServerError('workspacePath is not a directory', { status: 400, code: 'INVALID_PATH' });
      }
      realPath = realpathSync(resolvedPath);
    } catch (err) {
      if (err instanceof ServerError) throw err;
      throw new ServerError('workspacePath is not accessible', { status: 400, code: 'INVALID_PATH' });
    }
    if (!isWithinAllowedRoots(realPath)) {
      console.error(`❌ ${outsideAllowedRootsMessage(realPath, { field: 'workspacePath' })}`);
      throw new ServerError('workspacePath is outside allowed directories', { status: 400, code: 'INVALID_PATH' });
    }
  }

  const io = req.app.get('io');

  // executeCommand reports validation failures through onComplete before it
  // returns null. Declare the id first so that synchronous callback cannot
  // access it in its temporal dead zone; there is no command-scoped socket
  // event to emit when no command was started.
  let commandId;
  commandId = commands.executeCommand(
    command,
    workspacePath,
    (data, stream) => {
      if (commandId) io?.emit(`command:${commandId}:data`, { data, stream });
    },
    (result) => {
      if (commandId) io?.emit(`command:${commandId}:complete`, result);
    }
  );

  if (!commandId) {
    throw new ServerError('Command not allowed', { status: 403, code: 'FORBIDDEN' });
  }

  res.status(202).json({ commandId, status: 'started' });
}));

// POST /api/commands/:id/stop - Stop a running command
router.post('/:id/stop', requireHostControl, asyncHandler(async (req, res) => {
  const stopped = commands.stopCommand(req.params.id);

  if (!stopped) {
    throw new ServerError('Command not found or not active', { status: 404, code: 'NOT_ACTIVE' });
  }

  res.json({ stopped: true });
}));

// GET /api/commands/allowed - Get allowed commands
router.get('/allowed', asyncHandler(async (req, res) => {
  res.json(commands.getAllowedCommands());
}));

// GET /api/commands/processes - Get PM2 process list with details
router.get('/processes', asyncHandler(async (req, res) => {
  const { appId } = validateRequest(processListQuerySchema, req.query);
  const app = appId ? await (await import('../services/apps.js')).getAppById(appId) : null;
  if (appId && !app) throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  const processes = await pm2Service.listProcessesStrict(app?.pm2Home || null);
  if (processes === null) throw new ServerError('PM2 status unavailable', { status: 503, code: 'PM2_UNAVAILABLE' });
  res.json(processes);
}));

// Apply a scoped process action and return its resulting snapshot.
router.post('/processes/:name/action', requireHostControl, asyncHandler(async (req, res) => {
  const { action, appId } = validateRequest(processActionSchema, req.body);
  const name = req.params.name;
  const command = validateCommand(`pm2 ${action} ${name}`);
  if (!command.valid || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith('-')) {
    throw new ServerError('Process command not allowed', { status: 403, code: 'FORBIDDEN' });
  }
  const app = appId ? await (await import('../services/apps.js')).getAppById(appId) : null;
  if (appId && !app) throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  const home = app?.pm2Home || null;
  const before = await pm2Service.listProcessesStrict(home);
  if (!before) throw new ServerError('PM2 status unavailable', { status: 503, code: 'PM2_UNAVAILABLE' });
  if (!before.some(proc => proc.name === name)) throw new ServerError('Process not found', { status: 404, code: 'NOT_FOUND' });
  // Restart also starts an existing stopped process without inventing a script.
  if (action === 'stop') await pm2Service.stopApp(name, home);
  else await pm2Service.restartApp(name, home);
  pm2Service.clearJlistCache(home);
  res.json({ processes: await pm2Service.listProcessesStrict(home) });
}));

// GET /api/commands/processes/:name/monit - Get PM2 monit data for a process
router.get('/processes/:name/monit', asyncHandler(async (req, res) => {
  const processes = await pm2Service.listProcesses();
  const process = processes.find(p => p.name === req.params.name);

  if (!process) {
    throw new ServerError('Process not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json({
    name: process.name,
    status: process.status,
    pid: process.pid,
    cpu: process.cpu,
    memory: process.memory,
    uptime: process.uptime,
    restarts: process.restarts
  });
}));

export default router;
