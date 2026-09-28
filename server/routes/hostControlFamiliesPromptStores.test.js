import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (original) => ({
  ...await original(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-operator'),
}));
vi.mock('../services/settings.js', async (original) => ({
  ...await original(), getSettings: vi.fn(async () => ({})),
}));
const twin = vi.hoisted(() => ({
  current: {},
  loadMeta: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../services/digital-twin.js', () => twin);
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import settingsRoutes from './digital-twin/settings.js';

const writes = [
  ['post', '/api/prompts'], ['put', '/api/prompts/cd-plan'],
  ['post', '/api/prompts/variables'], ['put', '/api/prompts/variables/example'],
  ['post', '/api/cos/mind/bundle/apply'],
  ['post', '/api/cos/mind/recipes'], ['put', '/api/cos/mind/recipes/example'],
  ['post', '/api/cos/mind/recipes/example/restore'],
  ['post', '/api/cos/mind/messages'], ['post', '/api/cos/mind/annotations'],
  ['post', '/api/cos/mind/journal/example/correct'], ['post', '/api/cos/mind/attachments'],
  ['post', '/api/cos/goal-fidelity/false-positive'],
  ['post', '/api/cos/mind/maintainer/watchdog'],
  ['post', '/api/digital-twin/personas'], ['put', '/api/digital-twin/personas/active'],
  ['put', '/api/digital-twin/personas/example'],
  ['post', '/api/tools'], ['put', '/api/tools/example'],
];
// Sentinel store handlers prove the real gates refuse before any write.
// The actual settings router is needed for its changed-value body gate.
const persisted = [];
const appFor = (address) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  for (const [method, path] of writes) app[method](path, (req, res) => {
    persisted.push(req.body);
    res.json({ saved: true });
  });
  app.use('/api/digital-twin', settingsRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (address, [method, path], body = {}, headers = {}) => {
  const pending = request(appFor(address))[method](path);
  for (const [key, value] of Object.entries(headers)) pending.set(key, value);
  return pending.send(body);
};
const refused = response => {
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
};
beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  persisted.length = 0;
  twin.current = { autoInjectToCoS: true, includePrivacyContext: false, activePersonaId: null, maxContextTokens: 4000 };
  twin.loadMeta.mockImplementation(async () => ({ settings: { ...twin.current } }));
  twin.updateSettings.mockImplementation(async data => Object.assign(twin.current, data));
});
describe('prompt store operator authority (#9040)', () => {
  it('refuses every instruction-store write from a remote socket or forwarded remote browser without changing stores', async () => {
    for (const write of writes) {
      refused(await call('192.0.2.10', write, { content: 'untrusted directive' }));
      refused(await call('127.0.0.1', write, {}, { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }));
    }
    expect(persisted).toEqual([]);
  });
  it('allows all instruction-store writes from loopback and authenticated remote operator sessions', async () => {
    for (const enabled of [false, true]) {
      auth.enabled = enabled;
      for (const write of writes) {
        const response = await call(enabled ? '192.0.2.10' : '127.0.0.1', write, {},
          enabled ? { Authorization: 'Bearer example-operator' } : {});
        expect(response.status).toBe(200);
      }
    }
    expect(persisted).toHaveLength(writes.length * 2);
  });
  it('gates changed twin instruction settings, including the alternate active-persona path', async () => {
    const original = { ...twin.current };
    for (const data of [
      { autoInjectToCoS: false }, { includePrivacyContext: true },
      { activePersonaId: '00000000-0000-4000-8000-000000000001' },
    ]) refused(await call('192.0.2.10', ['put', '/api/digital-twin/settings'], data));
    expect(twin.current).toEqual(original);
    expect(twin.updateSettings).not.toHaveBeenCalled();
    for (const data of [{ maxContextTokens: 5000 }, { ...original, maxContextTokens: 6000 }]) {
      expect((await call('192.0.2.10', ['put', '/api/digital-twin/settings'], data)).status).toBe(200);
    }
    for (const enabled of [false, true]) {
      auth.enabled = enabled;
      expect((await call(enabled ? '192.0.2.10' : '127.0.0.1', ['put', '/api/digital-twin/settings'],
        { autoInjectToCoS: enabled, includePrivacyContext: !enabled },
        enabled ? { Authorization: 'Bearer example-operator' } : {})).status).toBe(200);
    }
  });
});
