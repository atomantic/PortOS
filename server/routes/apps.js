import { Router } from 'express';
import * as appsService from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import { logAction } from '../services/history.js';
import { validate, appSchema, appUpdateSchema } from '../lib/validation.js';

const router = Router();

// GET /api/apps - List all apps
router.get('/', async (req, res, next) => {
  console.log('📱 GET /api/apps - fetching apps list');
  const apps = await appsService.getAllApps();
  console.log(`📱 GET /api/apps - found ${apps.length} apps`);

  // Get all PM2 processes once
  const allPm2 = await pm2Service.listProcesses().catch(() => []);
  const pm2Map = new Map(allPm2.map(p => [p.name, p]));

  // Enrich with PM2 status
  const enriched = apps.map((app) => {
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

    return {
      ...app,
      pm2Status: statuses,
      overallStatus
    };
  });

  console.log(`📱 GET /api/apps - responding with ${enriched.length} apps`);
  res.json(enriched);
});

// GET /api/apps/:id - Get single app
router.get('/:id', async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  // Get PM2 status for each process
  const statuses = {};
  for (const processName of app.pm2ProcessNames || []) {
    const status = await pm2Service.getAppStatus(processName).catch(() => ({ status: 'unknown' }));
    statuses[processName] = status;
  }

  res.json({ ...app, pm2Status: statuses });
});

// POST /api/apps - Create new app
router.post('/', async (req, res, next) => {
  const validation = validate(appSchema, req.body);

  if (!validation.success) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: validation.errors
    });
  }

  const app = await appsService.createApp(validation.data);
  res.status(201).json(app);
});

// PUT /api/apps/:id - Update app
router.put('/:id', async (req, res, next) => {
  const validation = validate(appUpdateSchema, req.body);

  if (!validation.success) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: validation.errors
    });
  }

  const app = await appsService.updateApp(req.params.id, validation.data);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  res.json(app);
});

// DELETE /api/apps/:id - Delete app
router.delete('/:id', async (req, res, next) => {
  const deleted = await appsService.deleteApp(req.params.id);

  if (!deleted) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  res.status(204).send();
});

// POST /api/apps/:id/start - Start app via PM2
router.post('/:id/start', async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  const results = {};
  const commands = app.startCommands || ['npm run dev'];
  const processNames = app.pm2ProcessNames || [app.name.toLowerCase().replace(/\s+/g, '-')];

  for (let i = 0; i < processNames.length; i++) {
    const name = processNames[i];
    const command = commands[i] || commands[0];

    const result = await pm2Service.startWithCommand(name, app.repoPath, command)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('start', app.id, app.name, { processNames }, allSuccess);

  res.json({ success: true, results });
});

// POST /api/apps/:id/stop - Stop app
router.post('/:id/stop', async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.stopApp(name)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('stop', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);

  res.json({ success: true, results });
});

// POST /api/apps/:id/restart - Restart app
router.post('/:id/restart', async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.restartApp(name)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('restart', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);

  res.json({ success: true, results });
});

// GET /api/apps/:id/status - Get PM2 status
router.get('/:id/status', async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  const statuses = {};

  for (const name of app.pm2ProcessNames || []) {
    const status = await pm2Service.getAppStatus(name)
      .catch(err => ({ status: 'error', error: err.message }));
    statuses[name] = status;
  }

  res.json(statuses);
});

// GET /api/apps/:id/logs - Get logs
router.get('/:id/logs', async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);

  if (!app) {
    return res.status(404).json({ error: 'App not found', code: 'NOT_FOUND' });
  }

  const lines = parseInt(req.query.lines) || 100;
  const processName = req.query.process || app.pm2ProcessNames?.[0];

  if (!processName) {
    return res.status(400).json({ error: 'No process name specified', code: 'MISSING_PROCESS' });
  }

  const logs = await pm2Service.getLogs(processName, lines)
    .catch(err => `Error retrieving logs: ${err.message}`);

  res.json({ processName, lines, logs });
});

export default router;
