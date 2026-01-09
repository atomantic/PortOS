/**
 * Scripts API Routes
 *
 * Endpoints for managing scheduled scripts
 */

import { Router } from 'express';
import * as scriptRunner from '../services/scriptRunner.js';

const router = Router();

// GET /api/cos/scripts - List all scripts
router.get('/', async (req, res, next) => {
  const scripts = await scriptRunner.listScripts().catch(next);
  if (scripts) res.json({ scripts });
});

// GET /api/cos/scripts/presets - Get available schedule presets
router.get('/presets', (req, res) => {
  res.json({ presets: scriptRunner.getSchedulePresets() });
});

// GET /api/cos/scripts/allowed-commands - Get allowed commands for scripts
router.get('/allowed-commands', (req, res) => {
  res.json({ commands: scriptRunner.getAllowedScriptCommands() });
});

// GET /api/cos/scripts/jobs - Get scheduled job info
router.get('/jobs', (req, res) => {
  res.json({ jobs: scriptRunner.getScheduledJobs() });
});

// POST /api/cos/scripts - Create a new script
router.post('/', async (req, res, next) => {
  const { name, description, command, schedule, cronExpression, enabled, triggerAction, triggerPrompt, triggerPriority } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
  }

  if (!command) {
    return res.status(400).json({ error: 'command is required', code: 'VALIDATION_ERROR' });
  }

  const script = await scriptRunner.createScript({
    name,
    description,
    command,
    schedule,
    cronExpression,
    enabled,
    triggerAction,
    triggerPrompt,
    triggerPriority
  }).catch(next);

  if (script) res.status(201).json(script);
});

// GET /api/cos/scripts/:id - Get a specific script
router.get('/:id', async (req, res, next) => {
  const script = await scriptRunner.getScript(req.params.id).catch(next);

  if (script === null) {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  if (script) res.json(script);
});

// PUT /api/cos/scripts/:id - Update a script
router.put('/:id', async (req, res, next) => {
  const script = await scriptRunner.updateScript(req.params.id, req.body).catch(next);

  if (script === null) {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  if (script) res.json(script);
});

// DELETE /api/cos/scripts/:id - Delete a script
router.delete('/:id', async (req, res, next) => {
  const deleted = await scriptRunner.deleteScript(req.params.id).catch(next);

  if (deleted === false) {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  if (deleted) res.status(204).send();
});

// POST /api/cos/scripts/:id/run - Execute a script immediately
router.post('/:id/run', async (req, res, next) => {
  const result = await scriptRunner.executeScript(req.params.id).catch(next);

  if (result?.error === 'Script not found') {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  if (result) res.json(result);
});

// GET /api/cos/scripts/:id/runs - Get script run history
router.get('/:id/runs', async (req, res, next) => {
  const limit = parseInt(req.query.limit) || 10;
  const runs = await scriptRunner.getScriptRuns(req.params.id, limit).catch(next);

  if (runs) res.json({ runs });
});

export default router;
