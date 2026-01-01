import { Router } from 'express';
import * as runner from '../services/runner.js';

const router = Router();

// GET /api/runs - List runs
router.get('/', async (req, res, next) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  const result = await runner.listRuns(limit, offset).catch(next);
  if (result) res.json(result);
});

// POST /api/runs - Create and execute a new run
router.post('/', async (req, res, next) => {
  const { providerId, model, prompt, workspacePath, workspaceName } = req.body;

  if (!providerId) {
    return res.status(400).json({ error: 'providerId is required', code: 'VALIDATION_ERROR' });
  }

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required', code: 'VALIDATION_ERROR' });
  }

  const runData = await runner.createRun({
    providerId,
    model,
    prompt,
    workspacePath,
    workspaceName
  }).catch(err => {
    res.status(400).json({ error: err.message, code: 'RUN_ERROR' });
    return undefined;
  });

  if (!runData) return;

  const { runId, provider, metadata } = runData;
  const io = req.app.get('io');

  // Execute based on provider type
  if (provider.type === 'cli') {
    runner.executeCliRun(
      runId,
      provider,
      prompt,
      workspacePath,
      (data) => {
        // Stream output via Socket.IO
        io?.emit(`run:${runId}:data`, data);
      },
      (finalMetadata) => {
        io?.emit(`run:${runId}:complete`, finalMetadata);
      }
    );
  } else if (provider.type === 'api') {
    runner.executeApiRun(
      runId,
      provider,
      model,
      prompt,
      workspacePath,
      (data) => {
        io?.emit(`run:${runId}:data`, data);
      },
      (finalMetadata) => {
        io?.emit(`run:${runId}:complete`, finalMetadata);
      }
    );
  }

  // Return immediately with run ID
  res.status(202).json({
    runId,
    status: 'started',
    metadata
  });
});

// GET /api/runs/:id - Get run metadata
router.get('/:id', async (req, res, next) => {
  const metadata = await runner.getRun(req.params.id).catch(next);
  if (metadata === undefined) return;

  if (!metadata) {
    return res.status(404).json({ error: 'Run not found', code: 'NOT_FOUND' });
  }

  res.json({
    ...metadata,
    isActive: runner.isRunActive(req.params.id)
  });
});

// GET /api/runs/:id/output - Get run output
router.get('/:id/output', async (req, res, next) => {
  const output = await runner.getRunOutput(req.params.id).catch(next);
  if (output === undefined) return;

  if (output === null) {
    return res.status(404).json({ error: 'Run not found', code: 'NOT_FOUND' });
  }

  res.type('text/plain').send(output);
});

// GET /api/runs/:id/prompt - Get run prompt
router.get('/:id/prompt', async (req, res, next) => {
  const prompt = await runner.getRunPrompt(req.params.id).catch(next);
  if (prompt === undefined) return;

  if (prompt === null) {
    return res.status(404).json({ error: 'Run not found', code: 'NOT_FOUND' });
  }

  res.type('text/plain').send(prompt);
});

// POST /api/runs/:id/stop - Stop a running execution
router.post('/:id/stop', async (req, res, next) => {
  const stopped = await runner.stopRun(req.params.id).catch(next);
  if (stopped === undefined) return;

  if (!stopped) {
    return res.status(404).json({ error: 'Run not found or not active', code: 'NOT_ACTIVE' });
  }

  res.json({ stopped: true });
});

// DELETE /api/runs/:id - Delete run and artifacts
router.delete('/:id', async (req, res, next) => {
  // Don't allow deleting active runs
  if (runner.isRunActive(req.params.id)) {
    return res.status(409).json({ error: 'Cannot delete active run', code: 'RUN_ACTIVE' });
  }

  const deleted = await runner.deleteRun(req.params.id).catch(next);
  if (deleted === undefined) return;

  if (!deleted) {
    return res.status(404).json({ error: 'Run not found', code: 'NOT_FOUND' });
  }

  res.status(204).send();
});

export default router;
