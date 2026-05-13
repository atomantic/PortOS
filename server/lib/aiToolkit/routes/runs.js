import { Router } from 'express';
import { runSchema, validate } from '../validation.js';

export function createRunsRoutes(runnerService, options = {}) {
  const router = Router();
  const { asyncHandler = (fn) => fn, io = null } = options;

  router.get('/', asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const source = req.query.source || 'all';

    const result = await runnerService.listRuns(limit, offset, source);
    res.json(result);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    // Validate up front so invalid types (timeout: "abc", screenshots: "x")
    // can't reach the runner — setTimeout would treat "abc" as 0 and kill
    // the run immediately, and iterating a string `screenshots` would walk
    // characters as individual paths.
    const result = validate(runSchema, req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid run data', details: result.errors });
    }
    const { providerId, model, prompt, workspacePath, workspaceName, timeout, screenshots } = result.data;
    console.log(`🚀 POST /runs - provider: ${providerId}, model: ${model}, workspace: ${workspaceName}`);

    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const runData = await runnerService.createRun({
      providerId,
      model,
      prompt,
      workspacePath,
      workspaceName,
      timeout,
      screenshots
    });

    const { runId, provider, metadata, timeout: effectiveTimeout } = runData;
    console.log(`🚀 Run created: ${runId}, provider type: ${provider.type}`);

    if (provider.type === 'cli') {
      runnerService.executeCliRun(
        runId,
        provider,
        prompt,
        workspacePath,
        (data) => {
          io?.emit(`run:${runId}:data`, data);
        },
        (finalMetadata) => {
          console.log(`✅ Run complete: ${runId}, success: ${finalMetadata.success}`);
          io?.emit(`run:${runId}:complete`, finalMetadata);
        },
        effectiveTimeout
      );
    } else if (provider.type === 'api') {
      runnerService.executeApiRun(
        runId,
        provider,
        model,
        prompt,
        workspacePath,
        screenshots,
        (data) => {
          io?.emit(`run:${runId}:data`, data);
        },
        (finalMetadata) => {
          io?.emit(`run:${runId}:complete`, finalMetadata);
        }
      );
    }

    res.status(202).json({
      runId,
      status: 'started',
      metadata
    });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const metadata = await runnerService.getRun(req.params.id);

    if (!metadata) {
      return res.status(404).json({ error: 'Run not found' });
    }

    const isActive = await runnerService.isRunActive(req.params.id);
    res.json({
      ...metadata,
      isActive
    });
  }));

  router.get('/:id/output', asyncHandler(async (req, res) => {
    const output = await runnerService.getRunOutput(req.params.id);

    if (output === null) {
      return res.status(404).json({ error: 'Run not found' });
    }

    res.type('text/plain').send(output);
  }));

  router.get('/:id/prompt', asyncHandler(async (req, res) => {
    const prompt = await runnerService.getRunPrompt(req.params.id);

    if (prompt === null) {
      return res.status(404).json({ error: 'Run not found' });
    }

    res.type('text/plain').send(prompt);
  }));

  router.post('/:id/stop', asyncHandler(async (req, res) => {
    const stopped = await runnerService.stopRun(req.params.id);

    if (!stopped) {
      return res.status(404).json({ error: 'Run not found or not active' });
    }

    res.json({ success: true });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const deleted = await runnerService.deleteRun(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Run not found' });
    }

    res.status(204).send();
  }));

  router.delete('/', asyncHandler(async (req, res) => {
    if (req.query.filter !== 'failed') {
      return res.status(400).json({ error: 'Only filter=failed is supported for bulk delete' });
    }

    const deletedCount = await runnerService.deleteFailedRuns();
    res.json({ deletedCount });
  }));

  return router;
}
