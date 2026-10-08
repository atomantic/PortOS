import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

// Mount the real router/gates; double effects to prove refusal happens before
// stores, runs or queues are reached, without launching an actual provider.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-fableloom-authority-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/universeBuilder.js', () => ({ getUniverse: vi.fn() }));
vi.mock('../services/fableLoom/index.js', () => ({
  runEpisodeShotAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  applyEpisodeShots: vi.fn(async () => ({ id: 'example-record' })),
  addEpisode: vi.fn(async () => ({ id: 'example-record' })),
  addNode: vi.fn(async () => ({ id: 'example-record' })),
  addNodeTransition: vi.fn(async () => ({ id: 'example-record' })),
  branchNode: vi.fn(async () => ({ id: 'example-record' })),
  cancelFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  createLoom: vi.fn(async () => ({ id: 'example-record' })),
  deleteEpisode: vi.fn(async () => ({ id: 'example-record' })),
  deleteLoom: vi.fn(async () => ({ id: 'example-record' })),
  deleteNode: vi.fn(async () => ({ id: 'example-record' })),
  deleteNodeTransition: vi.fn(async () => ({ id: 'example-record' })),
  feedbackEpisode: vi.fn(async () => ({ id: 'example-record' })),
  feedbackSeriesPlan: vi.fn(async () => ({ id: 'example-record' })),
  generateEpisodeOutline: vi.fn(async () => ({ id: 'example-record' })),
  generateSeriesPlan: vi.fn(async () => ({ id: 'example-record' })),
  getFalVideoAutomation: vi.fn(async () => ({ id: 'example-record' })),
  getFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  getLatestFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  getLoom: vi.fn(async () => ({ id: 'example-record' })),
  listLoomSummaries: vi.fn(async () => []),
  playTurn: vi.fn(async () => ({ id: 'example-record' })),
  publicFableLoomEditorialAutopilot: vi.fn((run) => run),
  reformatEpisodeScenes: vi.fn(async () => ({ id: 'example-record' })),
  reviewEpisode: vi.fn(async () => ({ id: 'example-record' })),
  reviewEpisodeOutline: vi.fn(async () => ({ id: 'example-record' })),
  reviewFableLoomPlaythroughs: vi.fn(async () => ({ id: 'example-record' })),
  reviewSeriesPlan: vi.fn(async () => ({ id: 'example-record' })),
  reviewSeriesTeleplay: vi.fn(async () => ({ id: 'example-record' })),
  evaluateAndRemediateFableLoom: vi.fn(async () => ({ id: 'example-record' })),
  startFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  updateEpisode: vi.fn(async () => ({ id: 'example-record' })),
  updateLoom: vi.fn(async () => ({ id: 'example-record' })),
  updateNode: vi.fn(async () => ({ id: 'example-record' })),
  updateNodeTransition: vi.fn(async () => ({ id: 'example-record' })),
  validateEpisodeOutline: vi.fn(async () => ({ id: 'example-record' })),
  weaveEpisode: vi.fn(async () => ({ id: 'example-record' })),
  checkHostedSessionReadiness: vi.fn(async () => ({ id: 'example-record' })),
  createHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  getHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  updateHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  endHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  planEpisodeProduction: vi.fn(async () => ({ id: 'example-record' })),
  startEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  startFalVideoAutomation: vi.fn(async () => ({ id: 'example-record' })),
  getEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  getLatestEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  cancelEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  resumeEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  reviewEpisodeContinuity: vi.fn(async () => ({ id: 'example-record' })),
}));

import * as fableLoom from '../services/fableLoom/index.js';
import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import routes from './fableLoom.js';

const base = '/api/fableloom';
const loom = `${base}/example-loom`;
const episode = `${loom}/episodes/example-episode`;
const node = `${episode}/nodes/example-node`;
const picker = { providerId: 'example-cli', model: 'example-model' };
const operations = [
  [`${loom}/plan/generate`, picker, fableLoom.generateSeriesPlan],
  [`${loom}/plan/review`, picker, fableLoom.reviewSeriesPlan],
  [`${loom}/plan/feedback`, { ...picker, feedback: 'Example feedback' }, fableLoom.feedbackSeriesPlan],
  [`${loom}/review-teleplay`, picker, fableLoom.reviewSeriesTeleplay],
  [`${loom}/editorial/remediate`, picker, fableLoom.evaluateAndRemediateFableLoom],
  [`${loom}/playtest`, picker, fableLoom.reviewFableLoomPlaythroughs],
  [`${loom}/editorial/autopilot/start`, picker, fableLoom.startFableLoomEditorialAutopilot, 202],
  [`${episode}/weave`, picker, fableLoom.weaveEpisode],
  [`${episode}/shots/plan`, picker, fableLoom.runEpisodeShotAutopilot],
  [`${episode}/outline/generate`, picker, fableLoom.generateEpisodeOutline],
  [`${episode}/outline/review`, picker, fableLoom.reviewEpisodeOutline],
  [`${node}/branch`, picker, fableLoom.branchNode],
  [`${episode}/review`, picker, fableLoom.reviewEpisode],
  [`${episode}/feedback`, { ...picker, feedback: 'Example feedback' }, fableLoom.feedbackEpisode],
  [`${episode}/play`, { ...picker, nodeId: 'example-node', message: 'Example choice' }, fableLoom.playTurn],
  [`${episode}/reformat`, { ...picker, format: 'teleplay' }, fableLoom.reformatEpisodeScenes],
  [`${episode}/production/batch`, { imageMode: 'codex' }, fableLoom.startEpisodeProductionBatch, 201],
  [`${episode}/production/batch/example-run/resume`, {}, fableLoom.resumeEpisodeProductionBatch],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use(base, routes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [path, body], headers = {}, method = 'post') => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(fableLoom)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  fableLoom.getEpisodeProductionBatch.mockReturnValue({
    id: 'example-run', loomId: 'example-loom', episodeId: 'example-episode',
  });
});

describe('FableLoom agent workflow authority (#10668)', () => {
  it('refuses remote authoring and production before effects for CLI/TUI/API-first and Express spelling variants', async () => {
    const app = appFor();
    for (const [path, body] of operations) {
      for (const providerId of ['example-cli', 'example-tui', 'example-api']) {
        const response = await call(app, [path, { ...body, providerId }]);
        expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      const variant = await call(app, [path.toUpperCase() + '/', body]);
      expect([variant.status, variant.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('refuses proxy-marked, anonymous auth-on, Basic and scoped-peer callers', async () => {
    for (const [enabled, address, headers, status, code] of [
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [true, '192.0.2.10', {}, 401, 'AUTH_REQUIRED'],
      [true, '192.0.2.10', { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [true, '192.0.2.10', {
        [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
        [PEER_INSTANCE_HEADER]: 'example-instance',
      }, 403, 'PEER_SCOPE_FORBIDDEN'],
    ]) {
      auth.enabled = enabled;
      const app = appFor(address);
      for (const operation of operations) {
        const response = await call(app, operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('preserves genuine loopback, operator-session and delegated-agent workflows', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      const app = appFor(address);
      for (const [path, body, effect, status = 200] of operations) {
        const before = effect.mock.calls.length;
        const response = await call(app, [path, body], headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
        expect(effect, path).toHaveBeenCalledTimes(before + 1);
      }
    }
    expect(fableLoom.weaveEpisode).toHaveBeenLastCalledWith('example-loom', 'example-episode', picker);
    expect(fableLoom.resumeEpisodeProductionBatch).toHaveBeenLastCalledWith('example-run');
  });

  it('preserves remote record edits, deterministic validation/planning, cancellation and reads', async () => {
    const app = appFor();
    for (const [method, path, body, effect, status = 200] of [
      ['post', base, { name: 'Example Loom' }, fableLoom.createLoom, 201],
      ['patch', loom, { premise: 'Example premise' }, fableLoom.updateLoom],
      ['post', `${loom}/episodes`, { title: 'Example episode' }, fableLoom.addEpisode, 201],
      ['patch', node, { prose: 'Example prose' }, fableLoom.updateNode],
      ['post', `${episode}/outline/validate`, {}, fableLoom.validateEpisodeOutline],
      ['post', `${episode}/production/plan`, {}, fableLoom.planEpisodeProduction],
      ['post', `${episode}/continuity/review`, {}, fableLoom.reviewEpisodeContinuity],
      ['post', `${episode}/production/batch/example-run/cancel`, {}, fableLoom.cancelEpisodeProductionBatch],
      ['get', `${episode}/production/batch`, undefined, fableLoom.getLatestEpisodeProductionBatch],
    ]) {
      const before = effect.mock.calls.length;
      const response = await call(app, [path, body], {}, method);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
      expect(effect).toHaveBeenCalledTimes(before + 1);
    }
    for (const [, , effect] of operations) expect(effect).not.toHaveBeenCalled();
  });
});
