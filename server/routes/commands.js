import { Router } from 'express';
import * as commands from '../services/commands.js';
import * as pm2Service from '../services/pm2.js';

const router = Router();

// POST /api/commands/execute - Execute a command
router.post('/execute', (req, res) => {
  const { command, workspacePath } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'Command is required', code: 'MISSING_COMMAND' });
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
    return res.status(403).json({ error: 'Command not allowed', code: 'FORBIDDEN' });
  }

  res.status(202).json({ commandId, status: 'started' });
});

// POST /api/commands/:id/stop - Stop a running command
router.post('/:id/stop', (req, res) => {
  const stopped = commands.stopCommand(req.params.id);

  if (!stopped) {
    return res.status(404).json({ error: 'Command not found or not active', code: 'NOT_ACTIVE' });
  }

  res.json({ stopped: true });
});

// GET /api/commands/allowed - Get allowed commands
router.get('/allowed', (req, res) => {
  res.json(commands.getAllowedCommands());
});

// GET /api/commands/processes - Get PM2 process list with details
router.get('/processes', async (req, res, next) => {
  const processes = await pm2Service.listProcesses().catch(next);
  if (processes) res.json(processes);
});

// GET /api/commands/processes/:name/monit - Get PM2 monit data for a process
router.get('/processes/:name/monit', async (req, res, next) => {
  const processes = await pm2Service.listProcesses().catch(next);
  if (!processes) return;

  const process = processes.find(p => p.name === req.params.name);
  if (!process) {
    return res.status(404).json({ error: 'Process not found', code: 'NOT_FOUND' });
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
});

export default router;
