import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-creative-authority-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// The production routers behind the real auth gate and host-control gate, with
// every service boundary doubled: no store write, agent queue, scheduler or
// provider effect can run. The spies below are those effects.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));

const project = vi.hoisted(() => ({
  id: 'example-project', status: 'paused', treatment: null,
  directive: { goal: 'Example goal', deliverables: [], constraints: {} },
  plan: { steps: [{ stepId: 'example-step', toolName: 'example_tool', args: {}, dependsOn: [], status: 'blocked' }] },
}));
vi.mock('../services/creativeDirector/local.js', () => ({
  listProjects: vi.fn(async () => []),
  getProjectsByIds: vi.fn(async () => []),
  getProject: vi.fn(async () => project),
  createProject: vi.fn(async () => project),
  updateProject: vi.fn(async (_id, patch) => ({ ...project, ...patch })),
  deleteProject: vi.fn(async () => ({ ok: true })),
  setTreatment: vi.fn(async () => project),
  setPlan: vi.fn(async () => project),
  updatePlanStep: vi.fn(async () => project),
  updateScene: vi.fn(async () => project),
}));
vi.mock('../services/creativeDirector/completionHook.js', () => ({
  startCreativeDirectorProject: vi.fn(async () => undefined),
  advanceAfterSceneSettled: vi.fn(async () => undefined),
}));
vi.mock('../services/creativeDirector/planAdvance.js', () => ({
  advanceAfterPlanStepSettled: vi.fn(async () => undefined),
}));
vi.mock('../services/creative/toolRegistry.js', () => ({
  getAllCreativeToolMetadata: vi.fn(() => []),
  getCommissionPlanError: vi.fn(() => null),
}));
vi.mock('../services/creativeDirector/autoCast.js', () => ({
  suggestCastForBrief: vi.fn(async () => []),
  applyAutoCastToProject: vi.fn(async () => ({ project, added: [], suggestions: [] })),
  toSuggestionView: (hit) => hit,
}));
vi.mock('../services/creativeDirector/firstPassGen.js', () => ({ enqueueFirstPassPortraits: vi.fn(async () => null) }));
vi.mock('../services/creativeDirector/firstPassMusicGen.js', () => ({ enqueueFirstPassMusicBed: vi.fn(async () => null) }));
vi.mock('../services/creativeDirector/smokeTest.js', () => ({ createSmokeTestProject: vi.fn(async () => project) }));
vi.mock('../services/creativeDirector/stopProject.js', () => ({ stopProject: vi.fn(async () => ({ stopped: true })) }));
vi.mock('../services/creativeDirector/videoReview.js', () => ({
  getVideoReview: vi.fn(async () => ({})),
  reviewVideo: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/review.js', () => ({ reviewEvents: new EventEmitter() }));
vi.mock('../services/creativeCommissions/store.js', () => ({
  ERR_NOT_FOUND: 'NOT_FOUND',
  ERR_VALIDATION: 'VALIDATION',
  listCommissions: vi.fn(async () => []),
  getCommission: vi.fn(async () => ({ id: 'example-commission' })),
  createCommission: vi.fn(async () => ({ id: 'example-commission' })),
  updateCommission: vi.fn(async () => ({ id: 'example-commission' })),
  submitCommissionFeedback: vi.fn(async () => ({ id: 'example-commission' })),
  deleteCommission: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/creativeCommissions/scheduler.js', () => ({
  runCommissionNow: vi.fn(async () => ({ outcome: 'started' })),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import creativeDirectorRoutes from './creativeDirector.js';
import creativeCommissionRoutes from './creativeCommissions.js';
import * as local from '../services/creativeDirector/local.js';
import { startCreativeDirectorProject } from '../services/creativeDirector/completionHook.js';
import { applyAutoCastToProject } from '../services/creativeDirector/autoCast.js';
import { createSmokeTestProject } from '../services/creativeDirector/smokeTest.js';
import { stopProject } from '../services/creativeDirector/stopProject.js';
import { reviewVideo } from '../services/creativeDirector/videoReview.js';
import * as commissions from '../services/creativeCommissions/store.js';
import { runCommissionNow } from '../services/creativeCommissions/scheduler.js';
import { createSession, revokeSessionById } from '../services/auth.js';

const cd = '/api/creative-director';
const cc = '/api/creative-commission';
const revision = 'a'.repeat(32);
const scene = { sceneId: 'example-scene', order: 0, intent: 'Example intent', prompt: 'Example prompt', durationSeconds: 3 };
const commissionBrief = { intent: 'Example brief' };
const commissionSchedule = { kind: 'DAILY', atLocalTime: '09:00' };
const projectCreate = { name: 'Example', aspectRatio: '16:9', quality: 'standard', modelId: 'example-model', targetDurationSeconds: 10 };

// [method, path, body, success status, effect that must not run when refused]
const steering = [
  ['post', cd, projectCreate, 201, local.createProject],
  ['patch', `${cd}/example-project`, { name: 'Renamed' }, 200, local.updateProject],
  ['post', `${cd}/example-project/start`, {}, 200, startCreativeDirectorProject],
  ['post', `${cd}/example-project/resume`, {}, 200, startCreativeDirectorProject],
  ['post', `${cd}/example-project/directive`, { goal: 'Example goal' }, 200, local.updateProject],
  ['post', `${cd}/example-project/replan`, {}, 200, local.updateProject],
  ['post', `${cd}/example-project/plan/step/example-step`, { action: 'retry' }, 200, local.updatePlanStep],
  ['post', `${cd}/example-project/auto-cast`, {}, 200, applyAutoCastToProject],
  ['post', `${cd}/smoke-test`, {}, 201, createSmokeTestProject],
  ['post', `${cd}/example-project/review`, { action: 'approve', stage: 'rough-cut', revision }, 200, reviewVideo],
  ['patch', `${cd}/example-project/plan`, { steps: [{ stepId: 'example-step', toolName: 'example_tool' }] }, 200, local.setPlan],
  ['patch', `${cd}/example-project/treatment`, { logline: 'Example', synopsis: 'Example', scenes: [scene] }, 200, local.setTreatment],
  ['patch', `${cd}/example-project/scene/example-scene`, { status: 'accepted' }, 200, local.updateScene],
  ['post', cc, { name: 'Example', brief: commissionBrief, schedule: commissionSchedule }, 201, commissions.createCommission],
  ['patch', `${cc}/example-commission`, { enabled: true }, 200, commissions.updateCommission],
  ['post', `${cc}/example-commission/run`, {}, 202, runCommissionNow],
  ['post', `${cc}/example-commission/feedback`, { runId: 'example-run', rating: 'up' }, 201, commissions.submitCommissionFeedback],
];
// Reviewed operations that only reduce execution or remove records.
const harmless = [
  ['post', `${cd}/example-project/pause`, {}, 200, local.updateProject],
  ['post', `${cd}/example-project/stop`, {}, 200, stopProject],
  ['delete', `${cd}/example-project`, undefined, 200, local.deleteProject],
  ['post', `${cd}/auto-cast/suggest`, { brief: 'Example brief' }, 200, null],
  ['delete', `${cc}/example-commission`, undefined, 200, commissions.deleteCommission],
];
const effects = [...new Set(steering.map(([, , , , effect]) => effect))];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use(cd, creativeDirectorRoutes);
  app.use(cc, creativeCommissionRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return body === undefined ? pending : pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of effects) expect(effect).not.toHaveBeenCalled();
};

let ownerSession;
beforeEach(async () => {
  vi.clearAllMocks();
  auth.enabled = false;
  ownerSession = await createSession();
});

describe('Creative Director and Commission operator authority (#10867)', () => {
  it('refuses every steering mutation from a remote caller before any store, queue or scheduler effect', async () => {
    for (const operation of steering) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped peers', async () => {
    auth.enabled = true;
    for (const operation of steering) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
        [{ Authorization: 'Bearer invalid-session' }, 401, 'AUTH_REQUIRED'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([status, code]);
      }
    }
    const revoked = await createSession({ label: 'agent' });
    await revokeSessionById(revoked.id);
    for (const operation of steering) {
      const response = await call(appFor(), operation, { Cookie: `portos_auth=${revoked.token}` });
      expect([response.status, response.body.code], operation[1]).toEqual([401, 'AUTH_REQUIRED']);
    }
    expectNoEffects();
  });

  it('matches case and trailing-slash spellings of each gated route', async () => {
    for (const operation of steering) {
      const variant = [...operation];
      variant[1] = operation[1].toUpperCase() + '/';
      const response = await call(appFor(), variant);
      expect([response.status, response.body.code], operation[1]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('keeps every workflow, including agent callbacks, for local callers and operator or delegated agent sessions', async () => {
    const agentSession = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${ownerSession.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${ownerSession.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agentSession.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of steering) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[1]}: ${JSON.stringify(response.body)}`).toBe(operation[3]);
      }
    }
    for (const effect of effects) expect(effect).toHaveBeenCalled();
    // Each of the four principals reached Run Now once, and the starter via
    // Start, Resume and the smoke-test fixture.
    expect(runCommissionNow).toHaveBeenCalledTimes(4);
    expect(startCreativeDirectorProject).toHaveBeenCalledTimes(12);
  });

  it('leaves pause, stop, delete, catalog-only auto-cast suggestions and reads open to remote callers', async () => {
    const app = appFor();
    for (const operation of harmless) {
      const response = await call(app, operation);
      expect(response.status, operation[1]).toBe(operation[3]);
      if (operation[4]) expect(operation[4]).toHaveBeenCalled();
    }
    expect((await request(app).get(cd)).status).toBe(200);
    expect((await request(app).get(`${cc}/example-commission`)).status).toBe(200);
    expect(startCreativeDirectorProject).not.toHaveBeenCalled();
    expect(runCommissionNow).not.toHaveBeenCalled();
  });
});
