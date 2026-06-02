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

    // When createRun proactively swapped to a fallback (the requested provider
    // was benched), the request `model` was resolved against the now-benched
    // PRIMARY and almost never exists on the fallback — running it would leak
    // a bad model id onto the fallback (the same bug as the staged-LLM path).
    // Use the fallback's configured model (or its own default) instead; for
    // non-fallback runs keep honoring the request `model`.
    const runModel = runData.usedFallback
      ? (runData.fallbackModel || provider.defaultModel || null)
      : model;
    // executeCliRun reads `provider.defaultModel` for `--model` injection, so a
    // fallback pin must be threaded in via a clone (mirrors the TUI branch and
    // promptRunner's `providerForRun`). Only on the fallback path — non-fallback
    // CLI runs keep their existing behavior of using the provider's own default
    // (the request `model` has never been threaded into CLI runs here).
    const cliProvider = (runData.usedFallback && runModel && runModel !== provider.defaultModel)
      ? { ...provider, defaultModel: runModel }
      : provider;

    if (provider.type === 'cli') {
      runnerService.executeCliRun(
        runId,
        cliProvider,
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
        runModel,
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
    } else if (provider.type === 'tui' && typeof runnerService.executeTuiRun === 'function') {
      // Honor the user-picked model from the Runs UI — `executeTuiRun` reads
      // `provider.defaultModel` for its `--model` injection, so without the
      // clone every TUI run would silently fall back to the provider's saved
      // default even when the user picked something else. Uses `runModel` so a
      // fallback swap runs the fallback's model rather than leaking the
      // primary's request model onto the fallback.
      const effectiveProvider = runModel
        ? { ...provider, defaultModel: runModel }
        : provider;
      runnerService.executeTuiRun(
        runId,
        effectiveProvider,
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
    } else {
      return res.status(400).json({
        error: `Unsupported provider type: ${provider.type}`,
        details: provider.type === 'tui'
          ? 'TUI executor not attached to runner — check that executeTuiRun is patched in index.js'
          : `Known types: cli, api, tui (received: ${provider.type})`,
      });
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
