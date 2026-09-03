import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

const service = vi.hoisted(() => ({
  listHarnesses: vi.fn(),
  refreshHarnessModels: vi.fn(),
}));
vi.mock('../services/harnesses.js', () => service);

const stream = vi.hoisted(() => ({ streamHarnessAction: vi.fn(async (req, res) => res.json({ streamed: true })) }));
vi.mock('../services/harnessActionStream.js', () => stream);

import { errorMiddleware } from '../lib/errorHandler.js';
import harnessRoutes from './harnesses.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/harnesses', harnessRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('harness routes', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    stream.streamHarnessAction.mockImplementation(async (req, res) => res.json({ streamed: true }));
    service.listHarnesses.mockResolvedValue([{ id: 'opencode', label: 'OpenCode CLI' }]);
    app = makeApp();
  });

  it('lists harnesses, passing ?fresh through to bypass both caches', async () => {
    expect((await request(app).get('/api/harnesses')).status).toBe(200);
    expect(service.listHarnesses).toHaveBeenCalledWith({ fresh: false });

    const res = await request(app).get('/api/harnesses?fresh=1');
    expect(res.status).toBe(200);
    expect(service.listHarnesses).toHaveBeenLastCalledWith({ fresh: true });
    expect(res.body.harnesses).toHaveLength(1);
  });

  it('defaults the action to install and forwards the named runtime', async () => {
    expect((await request(app).post('/api/harnesses/action?runtime=opencode')).status).toBe(200);
    expect(stream.streamHarnessAction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { runtime: 'opencode', action: 'install' },
    );
  });

  it.each(['update', 'uninstall'])('forwards the %s action', async (action) => {
    const res = await request(app).post(`/api/harnesses/action?runtime=opencode&action=${action}`);
    expect(res.status).toBe(200);
    expect(stream.streamHarnessAction).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), { runtime: 'opencode', action },
    );
  });

  it('rejects an action outside the enum without reaching the stream', async () => {
    // The enum is the boundary guard: an unvalidated verb would reach a table
    // lookup instead of failing as a plain 400.
    expect((await request(app).post('/api/harnesses/action?runtime=opencode&action=purge')).status).toBe(400);
    expect(stream.streamHarnessAction).not.toHaveBeenCalled();
  });

  it('rejects a missing runtime', async () => {
    expect((await request(app).post('/api/harnesses/action')).status).toBe(400);
    expect(stream.streamHarnessAction).not.toHaveBeenCalled();
  });

  it('returns the refreshed catalog', async () => {
    service.refreshHarnessModels.mockResolvedValue({ ok: true, models: ['opencode/a'], updated: ['opencode-zen-cli'] });

    const res = await request(app).post('/api/harnesses/models/refresh?runtime=opencode');

    expect(res.status).toBe(200);
    expect(service.refreshHarnessModels).toHaveBeenCalledWith('opencode');
    expect(res.body).toEqual({ ok: true, models: ['opencode/a'], updated: ['opencode-zen-cli'] });
  });

  it('surfaces a refusal as a 409 carrying the service reason verbatim', async () => {
    // "signed out" / "cannot list models" are host states, not server faults —
    // and the page renders the sentence, so it must survive the round trip.
    service.refreshHarnessModels.mockResolvedValue({ ok: false, reason: 'Sign in first.', models: [], updated: [] });

    const res = await request(app).post('/api/harnesses/models/refresh?runtime=opencode');

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Sign in first.');
  });
});
