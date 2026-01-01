import { Router } from 'express';
import { spawn } from 'child_process';
import * as appsService from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';

const router = Router();

// GET /api/logs/processes - List all PM2 processes for log selection
router.get('/processes', async (req, res) => {
  const processes = await pm2Service.listProcesses().catch(() => []);
  res.json(processes);
});

// GET /api/logs/:processName - Get logs for a process (static or streaming)
router.get('/:processName', async (req, res) => {
  const { processName } = req.params;
  const lines = parseInt(req.query.lines) || 100;
  const follow = req.query.follow === 'true';

  if (!follow) {
    // Static log fetch
    const logs = await pm2Service.getLogs(processName, lines)
      .catch(err => `Error: ${err.message}`);
    return res.json({ processName, lines, logs });
  }

  // SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ processName, timestamp: Date.now() })}\n\n`);

  // Spawn pm2 logs with --raw flag for clean output
  const logProcess = spawn('pm2', ['logs', processName, '--raw', '--lines', String(lines)], {
    shell: false
  });

  let buffer = '';

  const sendLine = (line, type = 'log') => {
    if (line.trim()) {
      res.write(`event: ${type}\ndata: ${JSON.stringify({
        line,
        timestamp: Date.now(),
        type
      })}\n\n`);
    }
  };

  logProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(line => sendLine(line, 'stdout'));
  });

  logProcess.stderr.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(line => sendLine(line, 'stderr'));
  });

  logProcess.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  });

  logProcess.on('close', (code) => {
    res.write(`event: close\ndata: ${JSON.stringify({ code })}\n\n`);
    res.end();
  });

  // Cleanup on client disconnect
  req.on('close', () => {
    logProcess.kill('SIGTERM');
  });
});

// GET /api/logs/app/:appId - Get logs for all processes of an app
router.get('/app/:appId', async (req, res) => {
  const app = await appsService.getAppById(req.params.appId);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  const lines = parseInt(req.query.lines) || 100;
  const results = {};

  for (const processName of app.pm2ProcessNames || []) {
    results[processName] = await pm2Service.getLogs(processName, lines)
      .catch(err => `Error: ${err.message}`);
  }

  res.json({ app: app.name, processes: results });
});

export default router;
