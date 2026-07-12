import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/usage.js', () => ({
  getUsageSummary: vi.fn(),
  getUsage: vi.fn(),
  recordSession: vi.fn(),
  recordMessages: vi.fn(),
  recordTokens: vi.fn(),
  resetUsage: vi.fn()
}));

vi.mock('../services/providers.js', () => ({
  getAllProviders: vi.fn().mockResolvedValue([])
}));

vi.mock('../services/providerUsage.js', () => ({
  getProviderQuotas: vi.fn()
}));

vi.mock('../services/claudeCodeUsage.js', () => ({
  getClaudeCodeUsage: vi.fn()
}));

import * as usage from '../services/usage.js';
import { getAllProviders } from '../services/providers.js';
import { getProviderQuotas } from '../services/providerUsage.js';
import usageRoutes from './usage.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/usage', usageRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('usage routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/usage returns the usage summary with the default 7d range', async () => {
    usage.getUsageSummary.mockReturnValue({ totalSessions: 4, providers: ['anthropic'] });
    const res = await request(buildApp()).get('/api/usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalSessions: 4, providers: ['anthropic'] });
    const arg = usage.getUsageSummary.mock.calls[0][0];
    expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arg.to).toBeNull();
    expect(arg.providers).toEqual([]);
  });

  it('GET /api/usage passes an explicit from/to range through', async () => {
    usage.getUsageSummary.mockReturnValue({});
    getAllProviders.mockResolvedValue([{ id: 'ollama' }]);
    const res = await request(buildApp()).get('/api/usage?from=2026-01-01&to=2026-02-01');
    expect(res.status).toBe(200);
    expect(usage.getUsageSummary).toHaveBeenCalledWith({
      from: '2026-01-01',
      to: '2026-02-01',
      providers: [{ id: 'ollama' }]
    });
  });

  it('GET /api/usage resolves period=all to an unbounded range', async () => {
    usage.getUsageSummary.mockReturnValue({});
    const res = await request(buildApp()).get('/api/usage?period=all');
    expect(res.status).toBe(200);
    expect(usage.getUsageSummary.mock.calls[0][0]).toMatchObject({ from: null, to: null });
  });

  it('GET /api/usage rejects a malformed date', async () => {
    const res = await request(buildApp()).get('/api/usage?from=01-01-2026');
    expect(res.status).toBe(400);
    expect(usage.getUsageSummary).not.toHaveBeenCalled();
  });

  it('GET /api/usage rejects from after to', async () => {
    const res = await request(buildApp()).get('/api/usage?from=2026-03-01&to=2026-01-01');
    expect(res.status).toBe(400);
  });

  it('GET /api/usage rejects an unknown period', async () => {
    const res = await request(buildApp()).get('/api/usage?period=14d');
    expect(res.status).toBe(400);
  });

  it('GET /api/usage/providers returns quota entries and honors refresh', async () => {
    getProviderQuotas.mockResolvedValue([
      { family: 'claude', supported: true, limits: [] },
      { family: 'grok', supported: false, limits: [] }
    ]);
    const res = await request(buildApp()).get('/api/usage/providers?refresh=1');
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(2);
    expect(getProviderQuotas).toHaveBeenCalledWith({ refresh: true });
  });

  it('POST /api/usage/messages rejects negative or non-integer token counts', async () => {
    const res = await request(buildApp())
      .post('/api/usage/messages')
      .send({ providerId: 'p1', model: 'm', messageCount: 1, tokenCount: -5 });
    expect(res.status).toBe(400);
    expect(usage.recordMessages).not.toHaveBeenCalled();
  });

  it('GET /api/usage/raw returns the raw usage data', async () => {
    usage.getUsage.mockReturnValue({ sessions: [{ providerId: 'p1' }] });
    const res = await request(buildApp()).get('/api/usage/raw');
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].providerId).toBe('p1');
  });

  it('POST /api/usage/session records a session and returns its number', async () => {
    usage.recordSession.mockResolvedValue(42);
    const res = await request(buildApp())
      .post('/api/usage/session')
      .send({ providerId: 'anthropic', providerName: 'Anthropic', model: 'opus' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionNumber: 42 });
    expect(usage.recordSession).toHaveBeenCalledWith('anthropic', 'Anthropic', 'opus');
  });

  it('POST /api/usage/messages records messages and returns success', async () => {
    usage.recordMessages.mockResolvedValue();
    const res = await request(buildApp())
      .post('/api/usage/messages')
      .send({ providerId: 'p1', model: 'm', messageCount: 3, tokenCount: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(usage.recordMessages).toHaveBeenCalledWith('p1', 'm', 3, 1000, 0);
  });

  it('POST /api/usage/messages passes an input token count through', async () => {
    usage.recordMessages.mockResolvedValue();
    await request(buildApp())
      .post('/api/usage/messages')
      .send({ providerId: 'p1', model: 'm', messageCount: 1, tokenCount: 100, inputTokenCount: 400 });
    expect(usage.recordMessages).toHaveBeenCalledWith('p1', 'm', 1, 100, 400);
  });

  it('POST /api/usage/tokens defaults missing token counts to 0', async () => {
    usage.recordTokens.mockResolvedValue();
    const res = await request(buildApp()).post('/api/usage/tokens').send({});
    expect(res.status).toBe(200);
    expect(usage.recordTokens).toHaveBeenCalledWith(0, 0);
  });

  it('POST /api/usage/tokens passes through provided counts', async () => {
    usage.recordTokens.mockResolvedValue();
    await request(buildApp()).post('/api/usage/tokens').send({ inputTokens: 500, outputTokens: 200 });
    expect(usage.recordTokens).toHaveBeenCalledWith(500, 200);
  });

  it('DELETE /api/usage resets usage data', async () => {
    usage.resetUsage.mockResolvedValue();
    const res = await request(buildApp()).delete('/api/usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(usage.resetUsage).toHaveBeenCalled();
  });
});
