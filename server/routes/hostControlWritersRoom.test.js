import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-writers-authority-') }));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
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

// Mount the production router and gates; double effects so refusal cannot
// create records, start a background Polish loop, or reach a provider.
const effects = vi.hoisted(() => ({
  analysis: vi.fn(async () => ({ status: 'succeeded' })),
  polish: vi.fn(() => ({ runId: 'example-run' })),
  continuation: vi.fn(async () => ({ options: [] })),
  bridge: vi.fn(async () => ({ proposal: null })),
  augment: vi.fn(async () => ({ proposals: [] })),
  readWork: vi.fn(async () => ({ body: 'Example draft' })),
  updateWork: vi.fn(async (id, patch) => ({ id, ...patch })),
  cancel: vi.fn(() => true),
  listAnalyses: vi.fn(async () => []),
}));
vi.mock('../services/writersRoom/local.js', () => ({
  getWorkWithBody: effects.readWork, updateWork: effects.updateWork,
}));
vi.mock('../services/writersRoom/evaluator.js', () => ({
  runAnalysis: effects.analysis, listAnalyses: effects.listAnalyses,
}));
vi.mock('../services/writersRoom/polish.js', () => ({ startPolish: effects.polish, cancelPolish: effects.cancel }));
vi.mock('../services/writersRoom/liveDirector.js', () => ({
  suggestContinuation: effects.continuation, suggestCdBridge: effects.bridge,
}));
vi.mock('../services/writersRoom/castAugment.js', () => ({ proposeWorkCharacterAugmentation: effects.augment }));
vi.mock('../services/writersRoom/characters.js', () => ({}));
vi.mock('../services/writersRoom/places.js', () => ({}));
vi.mock('../services/writersRoom/objects.js', () => ({}));
vi.mock('../services/writersRoom/syncedReview.js', () => ({}));
vi.mock('../services/writersRoom/promoteToPipeline.js', () => ({}));
vi.mock('../services/catalogExtraction.js', () => ({}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import writersRoomRoutes from './writersRoom.js';

const work = '/api/writers-room/works/wr-work-example';
const operations = [
  [`${work}/analysis`, { kind: 'evaluate' }, effects.analysis, 201],
  [`${work}/polish/start`, { cycles: 1 }, effects.polish, 200],
  [`${work}/live-suggest`, { before: 'Example draft' }, effects.continuation, 200],
  [`${work}/cd-bridge/suggest`, { before: 'Example draft' }, effects.bridge, 200],
  [`${work}/characters/wr-char-example/augment`,
    { fields: ['want'], providerId: 'example-cli', model: 'example-model' }, effects.augment, 200],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/writers-room', writersRoomRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};
beforeEach(() => { vi.clearAllMocks(); auth.enabled = false; });

describe('Writers Room authoring authority', () => {
  it('refuses direct and proxied remote callers before reads, records or provider dispatch', async () => {
    for (const operation of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      const variant = await call(appFor(), [operation[0].toUpperCase() + '/', operation[1]]);
      expect([variant.status, variant.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('refuses anonymous, Basic and scoped-peer credentials when authentication is enabled', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{ [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance' }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('preserves local, operator and delegated agent workflows and provider selection', async () => {
    const owner = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${owner.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(operation[3]);
      }
    }
    for (const [, , effect] of operations) expect(effect).toHaveBeenCalledTimes(3);
    expect(effects.augment).toHaveBeenLastCalledWith('wr-work-example', 'wr-char-example', operations[4][1]);
  });

  it('leaves record edits, reads and cancellation accessible', async () => {
    const app = appFor();
    expect((await request(app).patch(work).send({ title: 'Example title' })).status).toBe(200);
    expect((await request(app).get(`${work}/analysis`)).status).toBe(200);
    expect((await call(app, [`${work}/polish/cancel`, {}])).status).toBe(200);
    expect(effects.updateWork).toHaveBeenCalledOnce();
    expect(effects.listAnalyses).toHaveBeenCalledOnce();
    expect(effects.cancel).toHaveBeenCalledOnce();
    for (const [, , effect] of operations) expect(effect).not.toHaveBeenCalled();
  });
});
