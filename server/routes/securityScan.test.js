import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const auth = vi.hoisted(() => ({ session: false, enabled: false }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: async () => auth.enabled,
  verifyRequestSession: async () => auth.session,
}));
vi.mock('../services/settings.js', () => ({ settingsEvents: new EventEmitter(), getSettings: async () => ({}) }));
vi.mock('../services/cos.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/agentSecurityScan.js', () => ({ runAgentSecurityScan: vi.fn(async () => ({ evidence: { status: 'running' } })) }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { runAgentSecurityScan } from '../services/agentSecurityScan.js';
import router from './cosAgentRoutes.js';

const appFor = address => {
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: address }); next(); });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/cos', router);
  app.use(errorMiddleware);
  return app;
};
const endpoint = '/api/cos/agents/agent-example/security-scan';
const input = { prompt: 'Audit the selected source boundary.', paths: ['server/routes'] };
beforeEach(() => { vi.clearAllMocks(); auth.session = false; auth.enabled = false; });

it('requires existing host authority before consuming a scanner grant', async () => {
  const denied = await request(appFor('192.0.2.10')).post(endpoint).send(input);
  expect(denied.status).toBe(403);
  expect(runAgentSecurityScan).not.toHaveBeenCalled();
  expect((await request(appFor('127.0.0.1')).post(endpoint).send(input)).status).toBe(200);
  auth.session = true; auth.enabled = true;
  expect((await request(appFor('192.0.2.10')).post(endpoint).send(input)).status).toBe(200);
  expect(runAgentSecurityScan).toHaveBeenCalledTimes(2);
});

it('rejects model, effort and budget overrides at the public request boundary', async () => {
  const result = await request(appFor('127.0.0.1')).post(endpoint).send({ ...input, model: 'another-model', effort: 'high', maxCostUsd: 10 });
  expect(result.status).toBe(400);
  expect(runAgentSecurityScan).not.toHaveBeenCalled();
});
