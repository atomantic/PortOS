import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-deck-chiptune-authority-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Mount the production Decks and Tracks routers behind the real gates. Only
// persistence, provider, queue and app-file effects are doubled (#10893).
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

const deckId = '00000000-0000-4000-8000-000000000001';
const cardId = '00000000-0000-4000-8000-000000000002';
vi.mock('../services/decks.js', () => ({
  listDecks: vi.fn(async () => []),
  getDeck: vi.fn(async () => ({
    id: '00000000-0000-4000-8000-000000000001',
    cards: [{ id: '00000000-0000-4000-8000-000000000002', key: 'example-card', prompt: '' }],
  })),
  applyCardGenerations: vi.fn(async () => 1),
}));
vi.mock('../services/deckStyleAnalysis.js', () => ({
  analyzeDeckSample: vi.fn(async () => ({ proposal: {} })),
}));
vi.mock('../services/deckPrompts.js', () => ({
  PROMPTS_PER_CALL: 16,
  castDeckFromUniverse: vi.fn(async () => ({ assignments: [] })),
  generateDeckCardPrompts: vi.fn(async () => ({ llm: {} })),
}));
vi.mock('../services/deckRender.js', () => ({
  renderDeckCards: vi.fn(async () => ({ queued: 1 })),
}));
vi.mock('../services/deckPromptProgress.js', () => ({
  attachClient: vi.fn(),
  beginPromptProgress: vi.fn(() => true),
  emitPromptProgress: vi.fn(),
  finishPromptProgress: vi.fn(),
}));
vi.mock('./universeBuilder/shared.js', () => ({
  resolveGalleryImageOrThrow: vi.fn((name) => ({ imageFilename: name, imagePath: `/example/${name}` })),
}));

vi.mock('../services/tracks/index.js', async () => ({
  ...await import('../services/tracks/logic.js'),
  getTrack: vi.fn(async (id) => ({ id })),
}));
vi.mock('../services/pipeline/musicLibrary.js', () => ({ MUSIC_UPLOAD_MAX_BYTES: 1024 }));
vi.mock('../services/trackAudioAttach.js', () => ({}));
vi.mock('../services/trackAlbumMembership.js', () => ({}));
vi.mock('../services/trackYoutubeImport.js', () => ({}));
vi.mock('../services/trackSunoImport.js', () => ({}));
vi.mock('../services/musicWaveform.js', () => ({}));
vi.mock('../services/musicCode.js', () => ({}));
vi.mock('../services/chiptune.js', () => ({
  generateChiptuneScore: vi.fn(async () => ({ track: {} })),
  renderChiptuneTrack: vi.fn(async () => ({ track: {} })),
  publishChiptuneTrack: vi.fn(async () => ({ published: true })),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import decksRoutes from './decks.js';
import tracksRoutes from './tracks.js';
import { createSession, revokeSessionById } from '../services/auth.js';
import { getDeck, applyCardGenerations } from '../services/decks.js';
import { analyzeDeckSample } from '../services/deckStyleAnalysis.js';
import { generateDeckCardPrompts } from '../services/deckPrompts.js';
import { renderDeckCards } from '../services/deckRender.js';
import { beginPromptProgress } from '../services/deckPromptProgress.js';
import { getTrack } from '../services/tracks/index.js';
import { generateChiptuneScore, renderChiptuneTrack, publishChiptuneTrack } from '../services/chiptune.js';

let ownerSession;
// An API-first pick (the shared runner can still fall back to a CLI/TUI) and an
// explicit tool-capable pick must be gated identically: authority never depends
// on the selected backend.
const apiPick = { providerId: 'example-api-provider', model: 'example-model' };
const cliPick = { providerId: 'example-cli-provider', model: 'example-model' };
const operations = [
  [`/api/decks/${deckId}/analyze-sample`, { image: 'example.png', ...apiPick }, analyzeDeckSample, 200],
  [`/api/decks/${deckId}/analyze-sample`, { image: 'example.png', ...cliPick }, analyzeDeckSample, 200],
  [`/api/decks/${deckId}/generate-prompts`, { ...apiPick }, generateDeckCardPrompts, 200],
  [`/api/decks/${deckId}/generate-prompts`, { ...cliPick }, generateDeckCardPrompts, 200],
  [`/api/decks/${deckId}/render`, { mode: 'local' }, renderDeckCards, 200],
  [`/api/decks/${deckId}/render`, { mode: 'grok' }, renderDeckCards, 200],
  [`/api/decks/${deckId}/cards/${cardId}/render`, { mode: 'local' }, renderDeckCards, 200],
  [`/api/decks/${deckId}/cards/${cardId}/render`, { mode: 'codex' }, renderDeckCards, 200],
  [`/api/tracks/${deckId}/chiptune/generate`, { prompt: 'Example tune', ...apiPick }, generateChiptuneScore, 200],
  [`/api/tracks/${deckId}/chiptune/generate`, { prompt: 'Example tune', ...cliPick }, generateChiptuneScore, 200],
  [`/api/tracks/${deckId}/chiptune/publish`, { appId: 'example-app' }, publishChiptuneTrack, 200],
];
const effects = [
  getDeck, applyCardGenerations, analyzeDeckSample, generateDeckCardPrompts, renderDeckCards,
  beginPromptProgress, getTrack, generateChiptuneScore, publishChiptuneTrack,
];
const expectNoEffects = () => {
  for (const effect of effects) expect(effect).not.toHaveBeenCalled();
};
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/decks', decksRoutes);
  app.use('/api/tracks', tracksRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

beforeEach(async () => {
  vi.clearAllMocks();
  auth.enabled = false;
  ownerSession = await createSession();
});

describe('Deck and chiptune host-action authority (#10893)', () => {
  it('refuses remote password-free and dev-proxy callers before any route, provider, store or app-file effect', async () => {
    for (const operation of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('gates before body validation so malformed requests learn nothing from a remote caller', async () => {
    for (const [path] of operations) {
      const response = await call(appFor(), [path, { unexpected: true }]);
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('requires authentication with a password, denies legacy Basic, and rejects scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Bearer invalid-session' }, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    const revoked = await createSession({ label: 'agent' });
    await revokeSessionById(revoked.id);
    const response = await call(appFor(), operations[0], { Cookie: `portos_auth=${revoked.token}` });
    expect(response.status).toBe(401);
    expectNoEffects();
  });

  it('matches case and trailing-slash variants', async () => {
    for (const [path, body] of operations) {
      const response = await call(appFor(), [path.toUpperCase() + '/', body]);
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('retains genuine local, operator and delegated-agent workflows with the chosen backend untouched', async () => {
    const agentSession = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${ownerSession.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${agentSession.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agentSession.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(operation[3]);
      }
    }
    expect(analyzeDeckSample).toHaveBeenCalledTimes(8);
    expect(analyzeDeckSample.mock.calls.map(([args]) => args.providerId))
      .toEqual(Array(4).fill(['example-api-provider', 'example-cli-provider']).flat());
    expect(generateDeckCardPrompts).toHaveBeenCalledTimes(8);
    expect(renderDeckCards).toHaveBeenCalledTimes(16);
    expect(renderDeckCards.mock.calls.map(([, options]) => options.mode)).toEqual(
      Array(4).fill(['local', 'grok', 'local', 'codex']).flat());
    expect(generateChiptuneScore).toHaveBeenCalledTimes(8);
    expect(generateChiptuneScore.mock.calls.map(([args]) => args.providerId))
      .toEqual(Array(4).fill(['example-api-provider', 'example-cli-provider']).flat());
    expect(publishChiptuneTrack).toHaveBeenCalledTimes(4);
  });

  it('keeps CRUD, progress, deterministic chiptune render and track reads open to remote callers', async () => {
    const app = appFor();
    expect((await request(app).get('/api/decks')).status).toBe(200);
    expect((await call(app, [`/api/tracks/${deckId}/chiptune/render`, {}])).status).toBe(200);
    expect(renderChiptuneTrack).toHaveBeenCalledTimes(1);
    expect(generateChiptuneScore).not.toHaveBeenCalled();
    expect(publishChiptuneTrack).not.toHaveBeenCalled();
    expect(analyzeDeckSample).not.toHaveBeenCalled();
    expect(generateDeckCardPrompts).not.toHaveBeenCalled();
    expect(renderDeckCards).not.toHaveBeenCalled();
  });
});
