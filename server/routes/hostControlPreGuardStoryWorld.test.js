import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-story-world-authority-') }));
afterAll(cleanupTempDataRoots);

// Continuous-video renders, fal.ai browser automation, editorial custom-check
// prompts run unattended, Creative Director hand-off, Eidoverse travel and the
// world config/controller surfaces that act as the CoS identity now need
// operator authority (#13055). Real routers behind the real gates; each effect
// is doubled at its service boundary, so an admitted request is a call on it.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  continuousVideo: vi.fn(async () => ({})),
  falVideo: vi.fn(async () => ({ jobId: 'example-job' })),
  saveSettings: vi.fn(),
  cdSend: vi.fn(async () => ({ project: { id: 'example-project' } })),
  depart: vi.fn(async () => ({ url: 'https://example.com/visit' })),
  worldConfig: vi.fn(async () => ({ config: {} })),
  controllerConfig: vi.fn(async () => ({ outcome: 'updated', install: { id: 'example-beacon' } })),
  install: vi.fn(async () => ({ outcome: 'installed', install: { id: 'example-beacon' } })),
  arm: vi.fn(async () => ({ outcome: 'updated', install: { id: 'example-beacon' } })),
}));
const settings = vi.hoisted(() => ({
  pipelineEditorialChecks: { customChecks: [{
    id: 'custom.example-check', label: 'Example check', prompt: 'Flag example problems',
    scope: 'issue', category: 'custom', severityDefault: 'medium',
  }] },
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => settings),
  updateSettingsWith: effects.saveSettings,
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/videoGen/continuousVideo.js', () => ({
  generateContinuousVideoEpisode: effects.continuousVideo,
  resolveEpisodeContinuity: vi.fn(async () => null),
  composeEpisodeClips: vi.fn(() => [{ prompt: 'Example clip' }]),
  attachEpisodeSseClient: vi.fn(() => false),
  CONTINUOUS_VIDEO_BACKENDS: ['local', 'reactor', 'fal'],
}));
vi.mock('../lib/videoPromptLinter.js', () => ({ lintClips: vi.fn(() => ({ pass: true })) }));
vi.mock('../services/fableLoom/index.js', () => ({ startFalVideoAutomation: effects.falVideo }));
vi.mock('../services/writersRoom/liveDirector.js', () => ({ sendToCreativeDirector: effects.cdSend }));
vi.mock('../services/writersRoom/local.js', () => ({}));
vi.mock('../services/writersRoom/evaluator.js', () => ({}));
vi.mock('../services/writersRoom/polish.js', () => ({}));
vi.mock('../services/writersRoom/syncedReview.js', () => ({}));
vi.mock('../services/writersRoom/characters.js', () => ({}));
vi.mock('../services/writersRoom/castAugment.js', () => ({}));
vi.mock('../services/writersRoom/places.js', () => ({}));
vi.mock('../services/writersRoom/objects.js', () => ({}));
vi.mock('../services/writersRoom/promoteToPipeline.js', () => ({}));
vi.mock('../services/catalogExtraction.js', () => ({}));
vi.mock('../services/eidoverseTravel.js', () => ({ visitEidoversePeer: effects.depart }));
vi.mock('../services/eidoverseWorld.js', () => ({ updateEidoverseWorldConfig: effects.worldConfig }));
vi.mock('../services/eidoverseControllerRuntime.js', () => ({
  installEidoverseController: effects.install,
  setEidoverseControllerArmed: effects.arm,
  updateEidoverseControllerConfig: effects.controllerConfig,
  summarizeControllerInstall: vi.fn((install) => install),
}));
vi.mock('../services/eidoverseFoundationLedger.js', () => ({}));
vi.mock('../services/eidoverseControllerRegistry.js', () => ({}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import continuousVideoRoutes from './continuousVideoEpisode.js';
import fableLoomRoutes from './fableLoom.js';
import pipelineEditorialRoutes from './pipeline/editorial.js';
import writersRoomRoutes from './writersRoom.js';
import travelRoutes from './eidoverseTravelRoutes.js';
import worldRoutes from './eidoverseWorldRoutes.js';

const customCheck = { label: 'Example check', prompt: 'Flag example problems' };
const beaconInstall = { id: 'example-beacon', controllerId: 'ambient-beacon' };
// [method, path, gated body, effect, status, open body (body-gated rows only)]
const operations = [
  ['post', '/api/continuous-video', {
    scenes: [{ lines: [{ type: 'action', text: 'Example action at dusk.' }] }], bible: {},
  }, effects.continuousVideo, 200],
  ['post', '/api/fableloom/example-loom/episodes/example-episode/nodes/example-node/fal-video',
    { prompt: 'Example scene direction, slow push-in.' }, effects.falVideo, 202],
  ['post', '/api/pipeline/editorial/custom-checks', customCheck, effects.saveSettings, 201],
  ['patch', '/api/pipeline/editorial/custom-checks/custom.example-check',
    { ...customCheck, prompt: 'Flag example problems more strictly' }, effects.saveSettings, 200],
  ['post', '/api/writers-room/works/wr-work-example/cd-bridge/send', { proposal: {
    logline: 'Example logline', synopsis: 'Example synopsis.',
    scenes: [{ intent: 'Open on the harbor', prompt: 'Wide shot of an example harbor at dawn', durationSeconds: 5 }],
  } }, effects.cdSend, 201],
  ['post', '/api/eidoverse/travel/depart', { peerId: 'example-peer' }, effects.depart, 200],
  ['put', '/api/eidoverse/world/config', { world: 'example-world', humanName: 'Example Human' }, effects.worldConfig, 200],
  ['patch', '/api/eidoverse/world/controllers/example-beacon/config',
    { config: { label: 'beacon', announce: true } }, effects.controllerConfig, 200],
  ['post', '/api/eidoverse/world/controllers',
    { ...beaconInstall, deliverEffects: true, config: { label: 'beacon', announce: true } },
    effects.install, 200, beaconInstall],
  ['patch', '/api/eidoverse/world/controllers/example-beacon', { armed: true }, effects.arm, 200, { armed: false }],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/continuous-video', continuousVideoRoutes);
  app.use('/api/fableloom', fableLoomRoutes);
  app.use('/api/pipeline', pipelineEditorialRoutes);
  app.use('/api/writers-room', writersRoomRoutes);
  app.use('/api/eidoverse/travel', travelRoutes);
  app.use('/api/eidoverse/world', worldRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.saveSettings.mockImplementation(async (mutate) => mutate(settings));
});

describe('story, video and Eidoverse world operator authority (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and case variants before any effect', async () => {
    for (const [method, path, body] of operations) {
      for (const [address, headers, target] of [
        ['192.0.2.10', {}, path],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, path],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }, path],
        ['192.0.2.10', {}, path.toUpperCase() + '/'],
      ]) {
        const response = await call(appFor(address), [method, target, body], headers);
        expect([response.status, response.body.code], `${method} ${target}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], `${operation[0]} ${operation[1]}`).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [method, path, body, effect, status] of operations) {
        const before = effect.mock.calls.length;
        const response = await call(appFor(address), [method, path, body], headers);
        expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
        expect(effect, `${method} ${path}`).toHaveBeenCalledTimes(before + 1);
      }
    }
    expect(effects.depart).toHaveBeenLastCalledWith({ peerId: 'example-peer', agent: false });
    expect(effects.install).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'example-beacon', deliverEffects: true }), { installedBy: 'user' });
    expect(effects.arm).toHaveBeenLastCalledWith('example-beacon', true);
    expect(effects.controllerConfig).toHaveBeenLastCalledWith('example-beacon', { label: 'beacon', announce: true });
  });

  it('leaves a non-delivering install and disarming open to a remote password-free caller', async () => {
    for (const [method, path, , effect, status, openBody] of operations.filter((operation) => operation[5])) {
      const response = await call(appFor(), [method, path, openBody]);
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
      expect(effect).toHaveBeenCalledTimes(1);
    }
    expect(effects.install).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'example-beacon', deliverEffects: false }), { installedBy: 'user' });
    expect(effects.arm).toHaveBeenCalledWith('example-beacon', false);
  });
});
