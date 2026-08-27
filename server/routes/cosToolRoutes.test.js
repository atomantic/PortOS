import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  format: vi.fn(),
  execute: vi.fn(),
  getCall: vi.fn(),
}));

vi.mock('../services/cosState.js', () => ({
  loadState: vi.fn(async () => ({ config: { persistentMindCapabilities: { readPortos: true } } })),
}));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ agentContext: { actions: { readPortos: false, writePortos: true } } })),
}));
vi.mock('../services/cosToolRegistry.js', () => ({
  getCosToolCatalog: (...args) => mocks.catalog(...args),
  formatCosToolCatalog: (...args) => mocks.format(...args),
  executeCosToolCall: (...args) => mocks.execute(...args),
  getCosToolCall: (...args) => mocks.getCall(...args),
}));

import routes from './cosToolRoutes.js';

const buildApp = ({ authenticated = false } = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.portosAuthContext = { authenticated };
    next();
  });
  app.use('/api/cos', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockReturnValue({ type: 'portos_tool_catalog', schemaVersion: 1, tools: [] });
  mocks.format.mockImplementation((catalog) => catalog);
  mocks.execute.mockResolvedValue({ type: 'portos_tool_result', requestId: 'call-1', state: 'completed' });
  mocks.getCall.mockResolvedValue({ type: 'portos_tool_result', requestId: 'call-1', state: 'completed' });
});

describe('CoS tool routes', () => {
  it('serves filtered/provider-formatted catalogs with a conditional ETag', async () => {
    const first = await request(buildApp()).get('/api/cos/tools?scope=mind&format=openai');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    expect(mocks.catalog).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mind' }));
    expect(mocks.format).toHaveBeenCalledWith(expect.any(Object), 'openai');
    const second = await request(buildApp()).get('/api/cos/tools?scope=mind&format=openai').set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
  });

  it('uses CoS-agent MCP grants for the agent catalog scope', async () => {
    const response = await request(buildApp()).get('/api/cos/tools?scope=agent');
    expect(response.status).toBe(200);
    expect(mocks.catalog).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'agent',
      capabilities: { readPortos: false, writePortos: true },
    }));
  });

  it('derives UI authority from the server auth context and checks idempotency headers', async () => {
    const body = { requestId: 'call-1', name: 'brain.search', arguments: { query: 'example' } };
    const res = await request(buildApp({ authenticated: true }))
      .post('/api/cos/tools/call')
      .set('Idempotency-Key', 'call-1')
      .send(body);
    expect(res.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      call: expect.objectContaining(body),
      authority: { scope: 'ui', authenticated: true },
    }));

    const mismatch = await request(buildApp()).post('/api/cos/tools/call').set('Idempotency-Key', 'other').send(body);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('TOOL_IDEMPOTENCY_MISMATCH');
  });

  it('reads retained results and 404s missing request ids', async () => {
    const found = await request(buildApp()).get('/api/cos/tools/calls/call-1');
    expect(found.status).toBe(200);
    mocks.getCall.mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/cos/tools/calls/missing');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TOOL_CALL_NOT_FOUND');
  });
});
