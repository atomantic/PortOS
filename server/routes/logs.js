import { Router } from 'express';
import * as appsService from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import { spawnPm2 } from '../services/pm2.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { openSseStream } from '../lib/sseDownload.js';
import { createLineReader } from '../lib/streamLines.js';

const router = Router();

/**
 * Validate PM2 process name to prevent command injection
 * PM2 names can contain alphanumeric, hyphens, underscores, and dots
 */
function validateProcessName(name) {
  if (typeof name !== 'string' || !name) {
    return null;
  }
  // Only allow safe characters for PM2 process names
  // Reject any shell metacharacters
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return null;
  }
  return name;
}

// GET /api/logs/processes - List all PM2 processes for log selection
router.get('/processes', asyncHandler(async (req, res) => {
  const processes = await pm2Service.listProcesses().catch(() => []);
  res.json(processes);
}));

// GET /api/logs/:processName - Get logs for a process (static or streaming)
router.get('/:processName', asyncHandler(async (req, res) => {
  const { processName } = req.params;
  const lines = parseInt(req.query.lines, 10) || 100;
  const follow = req.query.follow === 'true';

  // Security: Validate process name to prevent command injection
  const safeProcessName = validateProcessName(processName);
  if (!safeProcessName) {
    throw new ServerError('Invalid process name', { status: 400, code: 'INVALID_PROCESS_NAME' });
  }

  const pm2Home = await appsService.resolvePm2HomeForProcess(safeProcessName);

  if (!follow) {
    // Static log fetch
    const logs = await pm2Service.getLogs(safeProcessName, lines, pm2Home)
      .catch(err => `Error: ${err.message}`);
    return res.json({ processName: safeProcessName, lines, logs });
  }

  // SSE streaming — shared header boilerplate via openSseStream; this route
  // emits named `event:` frames directly so it uses safeEnd but not send.
  const { safeEnd } = openSseStream(res);

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ processName: safeProcessName, timestamp: Date.now() })}\n\n`);

  // Spawn pm2 logs with --raw flag for clean output
  // Security: safeProcessName is validated above to only contain safe characters
  const logProcess = spawnPm2(
    ['logs', safeProcessName, '--raw', '--lines', String(lines)],
    { env: pm2Service.buildEnv(pm2Home) }
  );

  const sendLine = (line, type = 'log') => {
    if (res.writableEnded || res.destroyed) return;
    if (line.trim()) {
      res.write(`event: ${type}\ndata: ${JSON.stringify({
        line,
        timestamp: Date.now(),
        type
      })}\n\n`);
    }
  };

  const stdoutReader = createLineReader(line => sendLine(line, 'stdout'));
  const stderrReader = createLineReader(line => sendLine(line, 'stderr'));
  logProcess.stdout.on('data', stdoutReader.push);
  logProcess.stderr.on('data', stderrReader.push);

  logProcess.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  });

  logProcess.on('close', (code) => {
    stdoutReader.flush();
    stderrReader.flush();
    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: close\ndata: ${JSON.stringify({ code })}\n\n`);
      safeEnd();
    }
  });

  // Cleanup on client disconnect
  req.on('close', () => {
    logProcess.kill('SIGTERM');
  });
}));

// GET /api/logs/app/:appId - Get logs for all processes of an app
router.get('/app/:appId', asyncHandler(async (req, res) => {
  const app = await appsService.getAppById(req.params.appId);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const lines = parseInt(req.query.lines, 10) || 100;
  const results = {};

  for (const processName of app.pm2ProcessNames || []) {
    results[processName] = await pm2Service.getLogs(processName, lines, app.pm2Home)
      .catch(err => `Error: ${err.message}`);
  }

  res.json({ app: app.name, processes: results });
}));

export default router;
