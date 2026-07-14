import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../testHelper.js';
import { asyncHandler, errorMiddleware, ServerError } from '../../errorHandler.js';
import { createRunsRoutes } from './runs.js';
import { createProvidersRoutes } from './providers.js';
import { createPromptsRoutes } from './prompts.js';
import { ToolkitHttpError, getErrorCode } from '../internal/httpError.js';

// Issue #1084 — toolkit route errors must normalize into PortOS's canonical
// error envelope `{ error, code, timestamp, context? }` (not the old
// `{ error, details }`) when the host injects its ServerError + asyncHandler.
// This suite pins that contract end-to-end through PortOS's real asyncHandler
// and errorMiddleware, and also pins the standalone default (ToolkitHttpError).

/** Mount a router under PortOS's asyncHandler + ServerError + errorMiddleware. */
function portosApp(mountPath, makeRouter) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, makeRouter({ asyncHandler, ServerError }));
  app.use(errorMiddleware);
  return app;
}

describe('issue-1084: toolkit routes emit the PortOS error envelope', () => {
  it('runs 404 (GET /:id missing) → { error, code, timestamp }', async () => {
    const runner = { getRun: vi.fn().mockResolvedValue(null), isRunActive: vi.fn() };
    const app = portosApp('/api/runs', (opts) => createRunsRoutes(runner, opts));

    const res = await request(app).get('/api/runs/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
    expect(res.body.code).toBe('NOT_FOUND');
    expect(typeof res.body.timestamp).toBe('number');
    // The retired shape used `details`; the envelope must not carry it here.
    expect(res.body.details).toBeUndefined();
  });

  it('runs 400 (invalid payload) → VALIDATION_ERROR with details in context', async () => {
    const runner = { createRun: vi.fn() };
    const app = portosApp('/api/runs', (opts) => createRunsRoutes(runner, opts));

    // `timeout: 'abc'` fails runSchema → the validation-reject branch.
    const res = await request(app).post('/api/runs').send({ providerId: 'p1', prompt: 'hi', timeout: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid run data');
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(typeof res.body.timestamp).toBe('number');
    // The zod issues moved from top-level `details` into `context.details`.
    expect(res.body.context?.details).toBeDefined();
    expect(runner.createRun).not.toHaveBeenCalled();
  });

  it('providers 404 (GET /:id missing) → NOT_FOUND envelope', async () => {
    const providers = { getProviderById: vi.fn().mockResolvedValue(null) };
    const app = portosApp('/api/providers', (opts) => createProvidersRoutes(providers, opts));

    const res = await request(app).get('/api/providers/ghost');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Provider not found', code: 'NOT_FOUND' });
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('providers 400 (POST missing name) → VALIDATION_ERROR envelope with details', async () => {
    const providers = { createProvider: vi.fn() };
    const app = portosApp('/api/providers', (opts) => createProvidersRoutes(providers, opts));

    // Missing `name` fails providerSchema → the validation-reject branch.
    const res = await request(app).post('/api/providers').send({ type: 'cli' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid provider data', code: 'VALIDATION_ERROR' });
    expect(res.body.context?.details?.some((d) => d.path === 'name')).toBe(true);
    expect(providers.createProvider).not.toHaveBeenCalled();
  });

  it('prompts 404 (GET /stages/:name missing) → NOT_FOUND envelope', async () => {
    const prompts = { getStage: vi.fn().mockReturnValue(null) };
    const app = portosApp('/api/prompts', (opts) => createPromptsRoutes(prompts, opts));

    const res = await request(app).get('/api/prompts/stages/missing');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Stage not found', code: 'NOT_FOUND' });
  });
});

describe('issue-1084: standalone default (no injected asyncHandler/ServerError)', () => {
  it('serializes the canonical JSON envelope via the toolkit defaults', async () => {
    // No asyncHandler/ServerError injected → routes throw ToolkitHttpError and
    // the toolkit's defaultAsyncHandler serializes the same envelope. Without
    // it, Express 5's built-in handler would honor the status but render an
    // HTML error page, dropping code/timestamp/context — assert the body, not
    // just the status, so that regression can't slip back in.
    const providers = { getProviderById: vi.fn().mockResolvedValue(null) };
    const app = express();
    app.use(express.json());
    app.use('/api/providers', createProvidersRoutes(providers));

    const res = await request(app).get('/api/providers/ghost');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toMatchObject({ error: 'Provider not found', code: 'NOT_FOUND' });
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('standalone validation error carries context.details as JSON', async () => {
    const runner = { createRun: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use('/api/runs', createRunsRoutes(runner));

    const res = await request(app).post('/api/runs').send({ providerId: 'p1', prompt: 'hi', timeout: 'abc' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toMatchObject({ error: 'Invalid run data', code: 'VALIDATION_ERROR' });
    expect(res.body.context?.details).toBeDefined();
    expect(runner.createRun).not.toHaveBeenCalled();
  });

  it('ToolkitHttpError derives code from status and stamps a timestamp', () => {
    const err = new ToolkitHttpError('boom', { status: 404 });
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
    expect(typeof err.timestamp).toBe('number');
    expect(err.context).toEqual({});
  });

  it('getErrorCode mirrors the PortOS status→code map', () => {
    expect(getErrorCode(400)).toBe('BAD_REQUEST');
    expect(getErrorCode(404)).toBe('NOT_FOUND');
    expect(getErrorCode(422)).toBe('VALIDATION_ERROR');
    expect(getErrorCode(599)).toBe('INTERNAL_ERROR');
  });
});
