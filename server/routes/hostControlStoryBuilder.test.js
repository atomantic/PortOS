import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { STEPS } from '../lib/storyBuilderSteps.js';

// Use the production router and gates, replacing only stores and execution
// boundaries. Refusal must happen before even reading the stored session.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => Object.fromEntries([
  'listStorySessions', 'getStorySession', 'createStorySession', 'updateStorySession',
  'deleteStorySession', 'lockStep', 'unlockStep', 'setCurrentStep', 'setIssueLock',
  'generateIssuesFromArc', 'setStorySessionSync', 'reconcileStorySession',
  'getStorySessionView', 'startStepRun', 'attachClient', 'listActiveStepRuns',
].map(name => [name, vi.fn(async () => ({ id: 'example-session' }))])));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-story-authority-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
vi.mock('../services/storyBuilder.js', () => ({
  ...effects, ERR_NOT_FOUND: 'STORY_BUILDER_NOT_FOUND', ERR_VALIDATION: 'STORY_BUILDER_VALIDATION',
}));
vi.mock('../services/storyBuilderRunner.js', () => ({
  startStepRun: effects.startStepRun, attachClient: effects.attachClient,
  listActiveStepRuns: effects.listActiveStepRuns,
}));

import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import storyRoutes from './storyBuilder.js';

const base = '/api/story-builder';
const session = `${base}/example-session`;
const operations = [
  ...STEPS.flatMap(({ id }) => [
    [`${session}/steps/${id}/generate`, { providerId: 'example-cli' }, 'generate'],
    [`${session}/steps/${id}/generate`, { providerId: 'example-api', fromDownstream: true }, 'backfill'],
    [`${session}/steps/${id}/refine`, { providerId: 'example-tui', feedback: 'Example feedback' }, 'refine'],
  ]),
  [`${session}/issues/generate`, { providerId: 'example-api' }, 'issues'],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use(base, storyRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, path, body, headers = {}, method = 'post') => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.getStorySessionView.mockResolvedValue({ session: { id: 'example-session' }, staleSteps: [], syncDrift: false });
  effects.startStepRun.mockReturnValue({ runId: 'example-run', alreadyRunning: false });
  effects.listActiveStepRuns.mockReturnValue([]);
  effects.attachClient.mockImplementation((_id, _step, res) => { res.end(); return true; });
});

describe('Story Builder generation authority (#10670)', () => {
  it('refuses remote generation, refinement and backfill before session reads or SSE admission regardless of provider or URL spelling', async () => {
    for (const [path, body] of operations) {
      for (const candidate of [path, path.toUpperCase() + '/']) {
        const response = await call(appFor(), candidate, body);
        expect([response.status, response.body.code], candidate).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('refuses remote callers forwarded through the local dev proxy and anonymous auth-on callers', async () => {
    for (const [enabled, headers, status, code] of [
      [false, { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [true, {}, 401, 'AUTH_REQUIRED'],
    ]) {
      auth.enabled = enabled;
      for (const [path, body] of operations) {
        const response = await call(appFor('127.0.0.1'), path, body, headers);
        expect([response.status, response.body.code]).toEqual([status, code]);
      }
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('preserves local auth-off, operator and delegated-agent generation plus progress attachment', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path, body, op] of operations) {
        const effect = op === 'issues' ? effects.generateIssuesFromArc : effects.startStepRun;
        const before = effect.mock.calls.length;
        const response = await call(appFor(address), path, body, headers);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(effect).toHaveBeenCalledTimes(before + 1);
        if (op !== 'issues') {
          expect(effect).toHaveBeenLastCalledWith('example-session', expect.any(String), expect.objectContaining({ op, ...body }));
          expect(response.body.runId).toBe('example-run');
        }
      }
      const progress = await call(appFor(address), `${session}/steps/idea/progress`, undefined, headers, 'get');
      expect(progress.status).toBe(200);
    }
    expect(effects.attachClient).toHaveBeenCalledTimes(3);
  });

  it('preserves remote CRUD, sync/reconcile, locks, current-step selection and progress reads', async () => {
    for (const [method, path, body, effect, status] of [
      ['post', base, { title: 'Example story' }, effects.createStorySession, 201],
      ['get', session, undefined, effects.getStorySessionView, 200],
      ['patch', session, { title: 'Example edited story' }, effects.updateStorySession, 200],
      ['delete', session, undefined, effects.deleteStorySession, 200],
      ['post', `${session}/sync`, { sync: true }, effects.setStorySessionSync, 200],
      ['post', `${session}/reconcile`, {}, effects.reconcileStorySession, 200],
      ['post', `${session}/current-step/idea`, {}, effects.setCurrentStep, 200],
      ['post', `${session}/steps/idea/lock`, {}, effects.lockStep, 200],
      ['post', `${session}/steps/idea/unlock`, {}, effects.unlockStep, 200],
      ['post', `${session}/issues/example-issue/lock`, { locked: true }, effects.setIssueLock, 200],
      ['get', `${session}/steps/idea/progress`, undefined, effects.attachClient, 200],
    ]) {
      const before = effect.mock.calls.length;
      const response = await call(appFor(), path, body, {}, method);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
      expect(effect).toHaveBeenCalledTimes(before + 1);
    }
    expect(effects.startStepRun).not.toHaveBeenCalled();
    expect(effects.generateIssuesFromArc).not.toHaveBeenCalled();
  });
});
