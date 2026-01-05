import { Router } from 'express';
import * as runner from '../services/runner.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/runs - List runs
// Query params: limit, offset, source (all|devtools|cos-agent)
router.get('/', asyncHandler(async (req, res, next) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const source = req.query.source || 'all'; // all, devtools, cos-agent

  const result = await runner.listRuns(limit, offset, source);
  res.json(result);
}));

// POST /api/runs - Create and execute a new run
router.post('/', asyncHandler(async (req, res, next) => {
  const { providerId, model, prompt, workspacePath, workspaceName } = req.body;
  console.log(`🚀 POST /api/runs - provider: ${providerId}, model: ${model}, workspace: ${workspaceName}`);

  if (!providerId) {
    throw new ServerError('providerId is required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  if (!prompt) {
    throw new ServerError('prompt is required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  const runData = await runner.createRun({
    providerId,
    model,
    prompt,
    workspacePath,
    workspaceName
  });

  const { runId, provider, metadata } = runData;
  const io = req.app.get('io');
  console.log(`🚀 Run created: ${runId}, provider type: ${provider.type}, command: ${provider.command}`);

  // Execute based on provider type
  if (provider.type === 'cli') {
    console.log(`🚀 Executing CLI run: ${provider.command} with args: ${JSON.stringify(provider.args)}`);
    runner.executeCliRun(
      runId,
      provider,
      prompt,
      workspacePath,
      (data) => {
        // Stream output via Socket.IO
        console.log(`📤 Emitting run:${runId}:data (${data.length} chars)`);
        io?.emit(`run:${runId}:data`, data);
      },
      (finalMetadata) => {
        console.log(`✅ Run complete: ${runId}, success: ${finalMetadata.success}`);
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
}));

// GET /api/runs/:id - Get run metadata
router.get('/:id', asyncHandler(async (req, res, next) => {
  const metadata = await runner.getRun(req.params.id);

  if (!metadata) {
    throw new ServerError('Run not found', {
      status: 404,
      code: 'NOT_FOUND'
    });
  }

  res.json({
    ...metadata,
    isActive: runner.isRunActive(req.params.id)
  });
}));

// GET /api/runs/:id/output - Get run output
router.get('/:id/output', asyncHandler(async (req, res, next) => {
  const output = await runner.getRunOutput(req.params.id);

  if (output === null) {
    throw new ServerError('Run not found', {
      status: 404,
      code: 'NOT_FOUND'
    });
  }

  res.type('text/plain').send(output);
}));

// GET /api/runs/:id/prompt - Get run prompt
router.get('/:id/prompt', asyncHandler(async (req, res, next) => {
  const prompt = await runner.getRunPrompt(req.params.id);

  if (prompt === null) {
    throw new ServerError('Run not found', {
      status: 404,
      code: 'NOT_FOUND'
    });
  }

  res.type('text/plain').send(prompt);
}));

// POST /api/runs/:id/stop - Stop a running execution
router.post('/:id/stop', asyncHandler(async (req, res, next) => {
  const stopped = await runner.stopRun(req.params.id);

  if (!stopped) {
    throw new ServerError('Run not found or not active', {
      status: 404,
      code: 'NOT_ACTIVE'
    });
  }

  res.json({ stopped: true });
}));

// DELETE /api/runs/:id - Delete run and artifacts
router.delete('/:id', asyncHandler(async (req, res, next) => {
  // Don't allow deleting active runs
  if (runner.isRunActive(req.params.id)) {
    throw new ServerError('Cannot delete active run', {
      status: 409,
      code: 'RUN_ACTIVE'
    });
  }

  const deleted = await runner.deleteRun(req.params.id);

  if (!deleted) {
    throw new ServerError('Run not found', {
      status: 404,
      code: 'NOT_FOUND'
    });
  }

  res.status(204).send();
}));

export default router;
