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

import * as usage from '../services/usage.js';
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

  it('GET /api/usage returns the usage summary', async () => {
    usage.getUsageSummary.mockReturnValue({ totalSessions: 4, providers: ['anthropic'] });
    const res = await request(buildApp()).get('/api/usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalSessions: 4, providers: ['anthropic'] });
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
    expect(usage.recordMessages).toHaveBeenCalledWith('p1', 'm', 3, 1000);
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
