import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

// Production router and auth/route/body gates; only stores and the terminal
// execution boundaries (provider dispatch, STT/network ingest) are replaced.
// A refused request must reach none of them, not even the scrap lookup.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  getScrap: vi.fn(),
  createChunkedScrap: vi.fn(),
  updateScrap: vi.fn(),
  listSourcesForScrap: vi.fn(async () => []),
  extract: vi.fn(),
  prune: vi.fn(),
  ingestUrl: vi.fn(),
  ingestFile: vi.fn(),
  ingestVoice: vi.fn(),
  ingestBrain: vi.fn(),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-catalog-authority-') }));
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
vi.mock('../services/catalogDB.js', () => ({
  getScrap: effects.getScrap,
  createChunkedScrap: effects.createChunkedScrap,
  updateScrap: effects.updateScrap,
  listSourcesForScrap: effects.listSourcesForScrap,
}));
vi.mock('../services/catalogExtraction.js', () => ({ extractIngredientsForScrap: effects.extract }));
vi.mock('../services/catalogPrune.js', () => ({ pruneCatalogBabble: effects.prune }));
vi.mock('../services/catalogIngestSources.js', () => ({
  ingestFromUrl: effects.ingestUrl, ingestFromFile: effects.ingestFile,
  ingestFromVoice: effects.ingestVoice, ingestFromBrain: effects.ingestBrain,
}));

import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import catalogRoutes from './catalog.js';

const scrapPath = '/api/catalog/scraps/example-scrap';
const generation = (path, body, effect) => ({ path, body, effect });
// Explicit CLI, TUI and API pins plus an unpinned request (inherited stage provider).
const operations = [
  generation(`${scrapPath}/extract`, {}, effects.extract),
  generation(`${scrapPath}/extract`, { providerOverride: 'example-cli', modelOverride: 'example-model' }, effects.extract),
  generation(`${scrapPath}/extract`, { providerOverride: 'example-tui' }, effects.extract),
  generation(`${scrapPath}/extract`, { providerOverride: 'example-api' }, effects.extract),
  generation(`${scrapPath}/prune`, { providerId: 'example-cli', model: 'example-model' }, effects.prune),
  generation(`${scrapPath}/prune`, { providerId: 'example-tui', model: 'example-model', effort: 'low' }, effects.prune),
  generation(`${scrapPath}/prune`, { providerId: 'example-api', model: 'example-model' }, effects.prune),
  generation('/api/catalog/ingest/url', { url: 'https://example.com/story' }, effects.ingestUrl),
  generation('/api/catalog/ingest/url', { url: 'https://example.com/story', providerOverride: 'example-cli' }, effects.ingestUrl),
  generation('/api/catalog/ingest/file', { text: 'Example text', filename: 'example.txt' }, effects.ingestFile),
  generation('/api/catalog/ingest/file', { text: 'Example text', filename: 'example.txt', providerOverride: 'example-tui' }, effects.ingestFile),
  generation('/api/catalog/ingest/voice', { audioBase64: 'ZXhhbXBsZQ==' }, effects.ingestVoice),
  generation('/api/catalog/ingest/voice', { audioBase64: 'ZXhhbXBsZQ==', providerOverride: 'example-api' }, effects.ingestVoice),
  generation('/api/catalog/ingest/brain', { brainType: 'ideas', brainId: 'example-record' }, effects.ingestBrain),
  generation('/api/catalog/ingest/brain', { brainType: 'ideas', brainId: 'example-record', providerOverride: 'example-cli' }, effects.ingestBrain),
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/catalog', catalogRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, path, body, headers = {}, method = 'post') => {
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
  effects.getScrap.mockResolvedValue({ id: 'example-scrap', rawText: 'Example text', parentScrapId: null });
  effects.createChunkedScrap.mockResolvedValue({ id: 'example-scrap' });
  effects.updateScrap.mockResolvedValue({ id: 'example-scrap' });
  for (const effect of [effects.extract, effects.prune, effects.ingestUrl, effects.ingestFile,
    effects.ingestVoice, effects.ingestBrain]) effect.mockResolvedValue({ scrap: { id: 'example-scrap' }, draft: {} });
});

describe('Catalog generation authority (#10891)', () => {
  it('refuses direct and dev-proxy-forwarded remote callers before any store, ingest or provider effect, whatever the provider pin or URL spelling', async () => {
    for (const { path, body } of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await call(appFor(address), path, body, headers);
        expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      const variant = await call(appFor(), path.toUpperCase() + '/', body);
      expect([variant.status, variant.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('refuses anonymous (401), legacy Basic and scoped-peer callers when authentication is enabled', async () => {
    auth.enabled = true;
    for (const { path, body } of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{ [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance' }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), path, body, headers);
        expect([response.status, response.body.code], path).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('preserves generation and provider pins for local auth-off, operator and delegated-agent callers', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const { path, body, effect } of operations) {
        const before = effect.mock.calls.length;
        const response = await call(appFor(address), path, body, headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
        expect(effect).toHaveBeenCalledTimes(before + 1);
      }
    }
    expect(effects.extract).toHaveBeenCalledWith(expect.objectContaining({
      scrapId: 'example-scrap', providerOverride: 'example-cli', modelOverride: 'example-model',
    }));
    expect(effects.prune).toHaveBeenCalledWith(expect.objectContaining({
      rawText: 'Example text', providerId: 'example-tui', model: 'example-model', effort: 'low',
    }));
  });

  it('keeps data-only scrap CRUD open to remote callers (not blanket-gated)', async () => {
    const created = await call(appFor(), '/api/catalog/scraps', { title: 'Example', rawText: 'Example text' });
    expect(created.status).toBe(201);
    const patched = await call(appFor(), scrapPath, { title: 'Edited' }, {}, 'patch');
    expect(patched.status).toBe(200);
    const read = await call(appFor(), scrapPath, undefined, {}, 'get');
    expect(read.status).toBe(200);
    expect(effects.createChunkedScrap).toHaveBeenCalledTimes(1);
    expect(effects.updateScrap).toHaveBeenCalledTimes(1);
    for (const effect of [effects.extract, effects.prune, effects.ingestUrl, effects.ingestFile,
      effects.ingestVoice, effects.ingestBrain]) expect(effect).not.toHaveBeenCalled();
  });
});
