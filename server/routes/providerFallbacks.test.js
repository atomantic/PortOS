import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({ getFallbackChain: vi.fn(), saveFallbackChain: vi.fn() }));
vi.mock('../services/providerFallbackChain.js', () => mocks);

const routes = (await import('./providerFallbacks.js')).default;
const app = express();
app.use(express.json());
app.use('/api/provider-fallbacks', routes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('provider fallback list routes', () => {
  it('saves an ordered list that repeats a preset with different models', async () => {
    const entries = [{ providerId: 'codex', model: 'm1', effort: 'max' }, { providerId: 'codex', model: 'm2' }, { providerId: 'agy' }];
    mocks.saveFallbackChain.mockResolvedValue(entries);
    const res = await request(app).put('/api/provider-fallbacks').send({ entries });
    expect(res.status).toBe(200);
    expect(mocks.saveFallbackChain).toHaveBeenCalledWith({ entries });
    expect(res.body.entries).toEqual(entries);
  });

  it('rejects a malformed provider reference before it reaches the store', async () => {
    const res = await request(app).put('/api/provider-fallbacks').send({ entries: [{ providerId: 'Not A Preset!' }] });
    expect(res.status).toBe(400);
    expect(mocks.saveFallbackChain).not.toHaveBeenCalled();
  });
});
