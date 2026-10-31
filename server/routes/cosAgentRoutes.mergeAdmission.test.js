import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const handoffPendingMerge = vi.hoisted(() => vi.fn(async () => ({ queued: false, reason: 'handoff-owner-unverified', retryable: false })));
vi.mock('../services/cosMergeHandoff.js', () => ({ handoffPendingMerge }));
vi.mock('../services/cosAgentArchive.js', () => ({}));
vi.mock('../services/cosAgentFeedback.js', () => ({}));
vi.mock('../services/cosAgentIndex.js', () => ({}));
vi.mock('../services/cosAgentLifecycle.js', () => ({}));
vi.mock('../services/cosHealthMonitor.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));

import routes from './cosAgentRoutes.js';

const app = express();
app.use(express.json());
app.use('/api/cos', routes);
app.use(errorMiddleware);

describe('POST /api/cos/merge-admission/external', () => {
  it('is gone: outside agents merge on the forge, with no PortOS lease', async () => {
    const res = await request(app).post('/api/cos/merge-admission/external').send({ action: 'acquire' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/cos/merge-handoff', () => {
  const body = { agentId: 'parent-example', prUrl: 'https://github.com/example/repo/pull/7', headSha: 'a'.repeat(40) };
  it('passes a well-formed handoff to the service and returns its verdict', async () => {
    const res = await request(app).post('/api/cos/merge-handoff').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: false, reason: 'handoff-owner-unverified', retryable: false });
    expect(handoffPendingMerge).toHaveBeenCalledWith(body);
  });

  it.each([
    ['an abbreviated head', { headSha: 'abc123' }],
    ['a non-URL PR', { prUrl: 'pull/7' }],
    ['no agent', { agentId: '' }],
  ])('rejects %s before the service runs', async (_name, override) => {
    handoffPendingMerge.mockClear();
    expect((await request(app).post('/api/cos/merge-handoff').send({ ...body, ...override })).status).toBe(400);
    expect(handoffPendingMerge).not.toHaveBeenCalled();
  });
});
