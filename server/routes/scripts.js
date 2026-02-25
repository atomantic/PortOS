/**
 * Scripts API Routes
 *
 * Endpoints for managing scheduled scripts
 */

import { Router } from 'express';
import * as scriptRunner from '../services/scriptRunner.js';
import { asyncHandler } from '../lib/errorHandler.js';

const router = Router();

// GET /api/cos/scripts - List all scripts
router.get('/', asyncHandler(async (req, res) => {
  const scripts = await scriptRunner.listScripts();
  res.json({ scripts });
}));

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
router.post('/', asyncHandler(async (req, res) => {
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
  });

  res.status(201).json(script);
}));

// GET /api/cos/scripts/:id - Get a specific script
router.get('/:id', asyncHandler(async (req, res) => {
  const script = await scriptRunner.getScript(req.params.id);

  if (script === null) {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  res.json(script);
}));

// PUT /api/cos/scripts/:id - Update a script
router.put('/:id', asyncHandler(async (req, res) => {
  const script = await scriptRunner.updateScript(req.params.id, req.body);

  if (script === null) {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  res.json(script);
}));

// DELETE /api/cos/scripts/:id - Delete a script
router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await scriptRunner.deleteScript(req.params.id);

  if (deleted === false) {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  res.status(204).send();
}));

// POST /api/cos/scripts/:id/run - Execute a script immediately
router.post('/:id/run', asyncHandler(async (req, res) => {
  const result = await scriptRunner.executeScript(req.params.id);

  if (result?.error === 'Script not found') {
    return res.status(404).json({ error: 'Script not found', code: 'NOT_FOUND' });
  }

  res.json(result);
}));

// GET /api/cos/scripts/:id/runs - Get script run history
router.get('/:id/runs', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const runs = await scriptRunner.getScriptRuns(req.params.id, limit);

  res.json({ runs });
}));

export default router;
