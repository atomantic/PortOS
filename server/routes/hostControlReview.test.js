import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real router and auth/host-control gates; only the queue service (whose sinks
// approve CoS tasks and create user tasks) and stores are replaced.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  resolveQueueItem: vi.fn(async () => ({ resolved: true })),
  promoteAskQueueItem: vi.fn(async () => ({ promoted: true })),
  triageQueueItem: vi.fn(async () => ({ triaged: true })),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-review-authority-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
vi.mock('../services/review.js', () => ({ reviewEvents: { emit: vi.fn() } }));
vi.mock('../services/reviewQueue.js', () => ({
  buildQueue: vi.fn(), claimQueueDelivery: vi.fn(), MAX_REVIEW_QUEUE_SNOOZE_MS: 30 * 24 * 60 * 60 * 1000, ...effects,
}));

import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import reviewRoutes from './review.js';

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/review', reviewRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, path, body, headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

// Every spelling that reaches CoS task approval, plus Ask promotion into a task.
const executing = [
  ['/api/review/queue/resolve', { id: 'cos:example-task', operation: 'approve' }, effects.resolveQueueItem],
  ['/api/review/queue/resolve', { id: 'cos:example-task', operation: 'resolve' }, effects.resolveQueueItem],
  ['/api/review/queue/resolve', { id: 'cos:example-task' }, effects.resolveQueueItem],
  ['/api/review/queue/resolve', { id: 'COS:example-task' }, effects.resolveQueueItem],
  ['/api/review/queue/promote-ask', { id: 'ask:example-conversation', target: 'task' }, effects.promoteAskQueueItem],
];
// Data-only operations keep their existing admission.
const dataOnly = [
  ['/api/review/queue/resolve', { id: 'memory:example-memory', operation: 'approve' }, effects.resolveQueueItem],
  ['/api/review/queue/resolve', { id: 'threads:example-thread', operation: 'complete' }, effects.resolveQueueItem],
  ['/api/review/queue/resolve', { id: 'health:example-alert' }, effects.resolveQueueItem],
  ['/api/review/queue/triage', { id: 'cos:example-task', operation: 'dismiss' }, effects.triageQueueItem],
  ['/api/review/queue/promote-ask', { id: 'ask:example-conversation', target: 'brain' }, effects.promoteAskQueueItem],
  ['/api/review/queue/promote-ask', { id: 'ask:example-conversation', target: 'goal', goalId: 'example-goal' }, effects.promoteAskQueueItem],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Review facade execution authority (#10890)', () => {
  it('refuses remote password-free CoS approval and Ask-to-task promotion before any service effect', async () => {
    for (const [path, body] of executing) {
      for (const candidate of [path, path.toUpperCase() + '/']) {
        const response = await call(appFor(), candidate, body);
        expect([response.status, response.body.code], `${candidate} ${JSON.stringify(body)}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('refuses dev-proxy-forwarded remote callers and keeps anonymous password-on callers at 401', async () => {
    for (const [enabled, headers, status, code] of [
      [false, { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [true, {}, 401, 'AUTH_REQUIRED'],
    ]) {
      auth.enabled = enabled;
      for (const [path, body] of executing) {
        const response = await call(appFor('127.0.0.1'), path, body, headers);
        expect([response.status, response.body.code]).toEqual([status, code]);
      }
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('preserves local password-free, operator and delegated-agent approval and promotion', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path, body, effect] of executing) {
        const before = effect.mock.calls.length;
        const response = await call(appFor(address), path, body, headers);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(effect).toHaveBeenCalledTimes(before + 1);
      }
    }
  });

  it('leaves data-only resolution, triage and Brain/Goal promotion open to remote password-free callers', async () => {
    for (const [path, body, effect] of dataOnly) {
      const before = effect.mock.calls.length;
      const response = await call(appFor(), path, body);
      expect(response.status, `${path} ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(effect).toHaveBeenCalledTimes(before + 1);
    }
  });
});
