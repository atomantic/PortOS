import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../testHelper.js';
import { createRunsRoutes } from './runs.js';

// Route-level harness for POST /api/runs fallback-model execution.
//
// The route derives `runModel` from `createRun`'s `usedFallback`/`fallbackModel`
// so a proactive fallback swap runs the FALLBACK provider's model rather than
// leaking the (now-benched) primary's request model onto the fallback. This
// suite pins that contract for all three provider types by spying on the
// runner's execute* methods and asserting which model id reaches each one.

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const REQUEST_MODEL = 'requested-model';

/**
 * Build an express app mounting the runs router over a fake runner whose
 * `createRun` resolves to `runData` and whose execute* methods are spies.
 * `runData.provider.type` selects which execute* branch the route takes.
 */
function makeApp(runData) {
  const runnerService = {
    createRun: vi.fn().mockResolvedValue(runData),
    executeApiRun: vi.fn(),
    executeCliRun: vi.fn(),
    executeTuiRun: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/runs', createRunsRoutes(runnerService, { asyncHandler }));
  return { app, runnerService };
}

/** Minimal runData skeleton the route destructures; override per-case. */
function runData({ providerType, defaultModel, usedFallback = false, fallbackModel = null }) {
  return {
    runId: 'run-1',
    provider: { id: 'fallback-or-primary', type: providerType, defaultModel },
    metadata: { id: 'run-1' },
    timeout: 60000,
    usedFallback,
    fallbackModel,
  };
}

const post = (app) =>
  request(app)
    .post('/api/runs')
    .send({ providerId: 'p1', model: REQUEST_MODEL, prompt: 'hello', workspaceName: 'ws' });

describe('POST /api/runs — fallback-model execution', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('(a) non-fallback runs honor the request model where the type threads it', () => {
    it('API: passes the request model as the 3rd executeApiRun arg', async () => {
      const { app, runnerService } = makeApp(
        runData({ providerType: 'api', defaultModel: 'provider-default' })
      );
      const res = await post(app);
      expect(res.status).toBe(202);
      expect(runnerService.executeApiRun).toHaveBeenCalledTimes(1);
      // executeApiRun(runId, provider, runModel, prompt, ...)
      expect(runnerService.executeApiRun.mock.calls[0][2]).toBe(REQUEST_MODEL);
    });

    it('TUI: clones the provider with the request model as defaultModel', async () => {
      const { app, runnerService } = makeApp(
        runData({ providerType: 'tui', defaultModel: 'provider-default' })
      );
      const res = await post(app);
      expect(res.status).toBe(202);
      expect(runnerService.executeTuiRun).toHaveBeenCalledTimes(1);
      // executeTuiRun(runId, effectiveProvider, prompt, ...)
      expect(runnerService.executeTuiRun.mock.calls[0][1].defaultModel).toBe(REQUEST_MODEL);
    });

    it('CLI: leaves the provider untouched (request model is never threaded into CLI runs)', async () => {
      const provider = runData({ providerType: 'cli', defaultModel: 'provider-default' });
      const { app, runnerService } = makeApp(provider);
      const res = await post(app);
      expect(res.status).toBe(202);
      expect(runnerService.executeCliRun).toHaveBeenCalledTimes(1);
      // executeCliRun(runId, cliProvider, prompt, ...): no clone, keeps provider's own default
      const cliProvider = runnerService.executeCliRun.mock.calls[0][1];
      expect(cliProvider).toBe(provider.provider);
      expect(cliProvider.defaultModel).toBe('provider-default');
    });
  });

  describe('(b) fallback swap with a configured fallbackModel runs that pinned model', () => {
    const PINNED = 'fallback-pinned-model';

    it('API: runs the pinned fallback model as the 3rd arg', async () => {
      const { app, runnerService } = makeApp(
        runData({ providerType: 'api', defaultModel: 'fallback-default', usedFallback: true, fallbackModel: PINNED })
      );
      await post(app);
      expect(runnerService.executeApiRun.mock.calls[0][2]).toBe(PINNED);
    });

    it('TUI: clones the fallback provider with the pinned model as defaultModel', async () => {
      const { app, runnerService } = makeApp(
        runData({ providerType: 'tui', defaultModel: 'fallback-default', usedFallback: true, fallbackModel: PINNED })
      );
      await post(app);
      expect(runnerService.executeTuiRun.mock.calls[0][1].defaultModel).toBe(PINNED);
    });

    it('CLI: clones the fallback provider with the pinned model as defaultModel', async () => {
      const run = runData({ providerType: 'cli', defaultModel: 'fallback-default', usedFallback: true, fallbackModel: PINNED });
      const { app, runnerService } = makeApp(run);
      await post(app);
      const cliProvider = runnerService.executeCliRun.mock.calls[0][1];
      expect(cliProvider.defaultModel).toBe(PINNED);
      // runModel !== provider.defaultModel, so the route must hand a *clone* to the
      // CLI runner — never mutate the shared fallback provider record.
      expect(cliProvider).not.toBe(run.provider);
    });
  });

  describe("(c) fallback swap with no pin runs the fallback provider's own default, never the primary's model", () => {
    const FALLBACK_DEFAULT = 'fallback-own-default';

    it('API: runs the fallback default and never the request model', async () => {
      const { app, runnerService } = makeApp(
        runData({ providerType: 'api', defaultModel: FALLBACK_DEFAULT, usedFallback: true, fallbackModel: null })
      );
      await post(app);
      expect(runnerService.executeApiRun.mock.calls[0][2]).toBe(FALLBACK_DEFAULT);
      expect(runnerService.executeApiRun.mock.calls[0][2]).not.toBe(REQUEST_MODEL);
    });

    it('TUI: clones the fallback provider with its own default, never the request model', async () => {
      const { app, runnerService } = makeApp(
        runData({ providerType: 'tui', defaultModel: FALLBACK_DEFAULT, usedFallback: true, fallbackModel: null })
      );
      await post(app);
      const tuiProvider = runnerService.executeTuiRun.mock.calls[0][1];
      expect(tuiProvider.defaultModel).toBe(FALLBACK_DEFAULT);
      expect(tuiProvider.defaultModel).not.toBe(REQUEST_MODEL);
    });

    it("CLI: uses the fallback provider's own default and never the request model", async () => {
      const provider = runData({ providerType: 'cli', defaultModel: FALLBACK_DEFAULT, usedFallback: true, fallbackModel: null });
      const { app, runnerService } = makeApp(provider);
      await post(app);
      // runModel === provider.defaultModel here, so the route skips the clone and
      // passes the fallback provider as-is — its default is already correct.
      const cliProvider = runnerService.executeCliRun.mock.calls[0][1];
      expect(cliProvider.defaultModel).toBe(FALLBACK_DEFAULT);
      expect(cliProvider.defaultModel).not.toBe(REQUEST_MODEL);
      // No pin and runModel === provider.defaultModel, so the route skips the clone
      // and passes the fallback provider as-is (its default is already correct).
      expect(cliProvider).toBe(provider.provider);
    });
  });

  it('rejects an invalid run payload before reaching the runner', async () => {
    const { app, runnerService } = makeApp(runData({ providerType: 'api', defaultModel: 'd' }));
    const res = await request(app).post('/api/runs').send({ providerId: 'p1', prompt: 'hi', timeout: 'abc' });
    expect(res.status).toBe(400);
    expect(runnerService.createRun).not.toHaveBeenCalled();
  });
});
