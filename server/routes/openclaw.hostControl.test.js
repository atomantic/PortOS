import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const auth = vi.hoisted(() => ({
  isAuthEnabled: vi.fn(async () => false),
  verifyPassword: vi.fn(async () => false),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-operator-session'),
}));
vi.mock('../services/auth.js', () => auth);
vi.mock('../services/settings.js', () => ({ settingsEvents: new EventEmitter(), getSettings: async () => ({}) }));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: async () => ({ peers: [] }) }));
vi.mock('../lib/securityAuditLog.js', () => ({ logSecurityEvent: vi.fn() }));
const upstream = vi.hoisted(() => ({
  isConfigured: vi.fn(async () => ({ configured: true })),
  getRuntimeStatus: vi.fn(), listSessions: vi.fn(), getSessionMessages: vi.fn(),
  sendSessionMessage: vi.fn(async () => ({ ok: true })),
  streamSessionMessage: vi.fn(async () => ({ response: { body: new ReadableStream({ start(controller) { controller.close(); } }) } })),
}));
vi.mock('../integrations/openclaw/api.js', () => upstream);
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import routes from './openclaw.js';

function app(address) {
  const server = express();
  server.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: address }); next(); });
  server.use(authGate, hostControlRouteGate, express.json());
  server.use('/api/openclaw', routes);
  server.use(errorMiddleware);
  return server;
}
beforeEach(() => { vi.clearAllMocks(); auth.isAuthEnabled.mockResolvedValue(false); });

it.each(['', '/stream'])('refuses remote unauthenticated operator messages%s before invoking the configured runtime', async suffix => {
  const response = await request(app('192.0.2.10')).post(`/api/openclaw/sessions/example/messages${suffix}`).send({ message: 'Run a task' });
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
  expect(upstream.isConfigured).not.toHaveBeenCalled();
  expect(upstream.sendSessionMessage).not.toHaveBeenCalled();
  expect(upstream.streamSessionMessage).not.toHaveBeenCalled();
});

it.each(['', '/stream'])('preserves local auth-off and verified operator session messages%s', async suffix => {
  const endpoint = `/api/openclaw/sessions/example/messages${suffix}`;
  expect((await request(app('127.0.0.1')).post(endpoint).send({ message: 'Run a task' })).status).toBe(200);
  auth.isAuthEnabled.mockResolvedValue(true);
  expect((await request(app('192.0.2.10')).post(endpoint).set('Authorization', 'Bearer example-operator-session').send({ message: 'Run a task' })).status).toBe(200);
  expect(suffix ? upstream.streamSessionMessage : upstream.sendSessionMessage).toHaveBeenCalledTimes(2);
});
