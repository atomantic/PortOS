import { Router } from 'express';
import { runSchema, validate, sanitizeScreenshotRefs } from '../validation.js';
import { ToolkitHttpError, defaultAsyncHandler } from '../internal/httpError.js';

export function createRunsRoutes(runnerService, options = {}) {
  const router = Router();
  // `asyncHandler`/`ServerError` are injected by the host (PortOS passes its
  // real ServerError + asyncHandler so thrown errors normalize into
  // `{ error, code, timestamp, context? }` and route to errorMiddleware).
  // Standalone, the toolkit's own defaults serialize the same envelope.
  const { asyncHandler = defaultAsyncHandler, io = null, ServerError = ToolkitHttpError } = options;

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
      throw new ServerError('Invalid run data', { status: 400, code: 'VALIDATION_ERROR', context: { details: result.errors } });
    }
    const { providerId, model, prompt, workspacePath, workspaceName, timeout, screenshots } = result.data;
    console.log(`🚀 POST /runs - provider: ${providerId}, model: ${model}, workspace: ${workspaceName}`);

    if (!providerId) {
      throw new ServerError('providerId is required', { status: 400 });
    }
    if (!prompt) {
      throw new ServerError('prompt is required', { status: 400 });
    }

    // `screenshots[]` is untrusted user input that the vision loader
    // base64-encodes and forwards to the external provider — constrain it to
    // safe screenshots-dir basenames here so a `../` traversal or absolute path
    // can't exfiltrate an arbitrary file (issue #1870). A non-image / traversal
    // entry is rejected loudly rather than silently dropped.
    const { safe: safeScreenshots, rejected } = sanitizeScreenshotRefs(screenshots);
    if (rejected.length > 0) {
      throw new ServerError('Invalid screenshot path', {
        status: 400,
        code: 'VALIDATION_ERROR',
        context: { details: `Disallowed screenshot reference(s): ${rejected.join(', ')}` },
      });
    }

    const runData = await runnerService.createRun({
      providerId,
      model,
      prompt,
      workspacePath,
      workspaceName,
      timeout,
      screenshots: safeScreenshots
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
      runnerService.executeCliRun({
        runId,
        provider: cliProvider,
        prompt,
        workspacePath,
        onData: (data) => {
          io?.emit(`run:${runId}:data`, data);
        },
        onComplete: (finalMetadata) => {
          console.log(`✅ Run complete: ${runId}, success: ${finalMetadata.success}`);
          io?.emit(`run:${runId}:complete`, finalMetadata);
        },
        timeout: effectiveTimeout,
      });
    } else if (provider.type === 'api') {
      runnerService.executeApiRun({
        runId,
        provider,
        model: runModel,
        prompt,
        workspacePath,
        screenshots: safeScreenshots,
        onData: (data) => {
          io?.emit(`run:${runId}:data`, data);
        },
        onComplete: (finalMetadata) => {
          io?.emit(`run:${runId}:complete`, finalMetadata);
        },
      });
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
      runnerService.executeTuiRun({
        runId,
        provider: effectiveProvider,
        prompt,
        workspacePath,
        onData: (data) => {
          io?.emit(`run:${runId}:data`, data);
        },
        onComplete: (finalMetadata) => {
          console.log(`✅ Run complete: ${runId}, success: ${finalMetadata.success}`);
          io?.emit(`run:${runId}:complete`, finalMetadata);
        },
        timeout: effectiveTimeout,
      });
    } else {
      throw new ServerError(`Unsupported provider type: ${provider.type}`, {
        status: 400,
        context: {
          details: provider.type === 'tui'
            ? 'TUI executor not attached to runner — check that setTuiRunner() was called in index.js'
            : `Known types: cli, api, tui (received: ${provider.type})`,
        },
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
      throw new ServerError('Run not found', { status: 404 });
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
      throw new ServerError('Run not found', { status: 404 });
    }

    res.type('text/plain').send(output);
  }));

  router.get('/:id/prompt', asyncHandler(async (req, res) => {
    const prompt = await runnerService.getRunPrompt(req.params.id);

    if (prompt === null) {
      throw new ServerError('Run not found', { status: 404 });
    }

    res.type('text/plain').send(prompt);
  }));

  router.post('/:id/stop', asyncHandler(async (req, res) => {
    const stopped = await runnerService.stopRun(req.params.id);

    if (!stopped) {
      throw new ServerError('Run not found or not active', { status: 404 });
    }

    res.json({ success: true });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const deleted = await runnerService.deleteRun(req.params.id);

    if (!deleted) {
      throw new ServerError('Run not found', { status: 404 });
    }

    res.status(204).send();
  }));

  router.delete('/', asyncHandler(async (req, res) => {
    if (req.query.filter !== 'failed') {
      throw new ServerError('Only filter=failed is supported for bulk delete', { status: 400 });
    }

    const deletedCount = await runnerService.deleteFailedRuns();
    res.json({ deletedCount });
  }));

  return router;
}
