import { Router } from 'express';
import { existsSync, statSync, realpathSync } from 'fs';
import { resolve } from 'path';
import * as commands from '../services/commands.js';
import * as pm2Service from '../services/pm2.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { isWithinAllowedRoots } from '../lib/workspaceRoots.js';

const router = Router();

// POST /api/commands/execute - Execute a command
router.post('/execute', asyncHandler(async (req, res) => {
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
      throw new ServerError('workspacePath is outside allowed directories', { status: 400, code: 'INVALID_PATH' });
    }
  }

  const io = req.app.get('io');

  const commandId = commands.executeCommand(
    command,
    workspacePath,
    (data, stream) => {
      io?.emit(`command:${commandId}:data`, { data, stream });
    },
    (result) => {
      io?.emit(`command:${commandId}:complete`, result);
    }
  );

  if (!commandId) {
    throw new ServerError('Command not allowed', { status: 403, code: 'FORBIDDEN' });
  }

  res.status(202).json({ commandId, status: 'started' });
}));

// POST /api/commands/:id/stop - Stop a running command
router.post('/:id/stop', asyncHandler(async (req, res) => {
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
  const processes = await pm2Service.listProcesses();
  res.json(processes);
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
