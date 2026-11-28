import { Router } from 'express';
import { validateCommand } from '../lib/commandSecurity.js';
import * as commands from '../services/commands.js';
import { requireHostControl } from '../services/authGate.js';
import { broadcastToCommandSubscribers } from '../services/socketIo.js';
import * as pm2Service from '../services/pm2.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { assertAllowedWorkspaceDir } from '../lib/workspaceRoots.js';
import { getAppById } from '../services/apps.js';
import { commandExecuteBodySchema, processListQuerySchema, processActionSchema } from '../lib/processValidation.js';

const router = Router();

// POST /api/commands/execute - Execute a command
router.post('/execute', requireHostControl, asyncHandler(async (req, res) => {
  const { command, workspacePath, timeoutMs } = validateRequest(commandExecuteBodySchema, req.body);

  if (workspacePath !== undefined && workspacePath !== null && workspacePath !== '') {
    assertAllowedWorkspaceDir(workspacePath, { field: 'workspacePath', outsideStatus: 400 });
  }

  // executeCommand reports validation failures through onComplete before it
  // returns null. Declare the id first so that synchronous callback cannot
  // access it in its temporal dead zone; there is no command-scoped socket
  // event to emit when no command was started. Output goes only to sockets
  // subscribed to command output, never to every connected socket (#12019).
  let commandId;
  commandId = commands.executeCommand(
    command,
    workspacePath,
    (data, stream) => {
      if (commandId) broadcastToCommandSubscribers(`command:${commandId}:data`, { data, stream });
    },
    (result) => {
      if (commandId) broadcastToCommandSubscribers(`command:${commandId}:complete`, result);
    },
    { timeoutMs }
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
  const app = appId ? await getAppById(appId) : null;
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
  const app = appId ? await getAppById(appId) : null;
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

export default router;
