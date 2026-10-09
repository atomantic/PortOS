import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

// Real gates, mounted routers and schemas. Stub the first service boundaries:
// refusal must happen before private reads, document writes or provider dispatch.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => Object.fromEntries([
  'generateEnrichmentQuestion', 'processEnrichmentAnswer', 'analyzeEnrichmentList',
  'detectContradictions', 'analyzeWritingSamples', 'compareSpokenWrittenStyle',
  'analyzeTraits', 'calculateConfidence', 'analyzeAssessment', 'runTests',
  'generateDynamicTests', 'runValuesAlignmentTests', 'runAdversarialTests',
  'runMultiTurnTests', 'polishAvatarBio', 'analyzeImportedData', 'getPersonaById',
  'saveEnrichmentListDocument', 'createDocument', 'updateTraits',
  'saveImportAsDocument', 'analyzeIdentityImage', 'getTestHistory',
].map(name => [name, vi.fn(async () => ({ id: 'example-record' }))])));
const evidence = vi.hoisted(() => ({
  interpretConsumption: vi.fn(async () => ({ text: 'Example interpretation' })),
  aggregateTwinEvidence: vi.fn(async () => ({})),
  getObservedEvidence: vi.fn(async () => ({})),
}));
const spotify = vi.hoisted(() => ({
  openSpotifyBrowser: vi.fn(async () => ({})),
  importSpotifyFromBrowser: vi.fn(async () => ({})),
}));
vi.mock('../lib/fileUtils.js', async (original) => ({
  ...makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-twin-authority-') }),
}));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (original) => ({
  ...await original(),
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
vi.mock('../services/digital-twin.js', () => effects);
vi.mock('../services/twinEnrichment.js', () => evidence);
vi.mock('../services/spotifyBrowserImport.js', () => spotify);

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import enrichmentRoutes from './digital-twin/enrichment.js';
import analysisRoutes from './digital-twin/analysis.js';
import testRoutes from './digital-twin/tests.js';
import avatarBioRoutes from './digital-twin/avatar-bio.js';
import importRoutes from './digital-twin/import.js';
import evidenceRoutes from './digital-twin/evidence.js';
import documentRoutes from './digital-twin/documents.js';

const picker = { providerId: 'example-cli', model: 'example-model' };
const personaId = '00000000-0000-4000-8000-000000000001';
const items = [{ title: 'Example book', note: 'Example note' }];
const operations = [
  ['enrich/question', { category: 'favorite_books', providerOverride: picker.providerId }, effects.generateEnrichmentQuestion],
  ['enrich/answer', { questionId: personaId, category: 'favorite_books', question: 'Example question?', answer: 'Example answer', providerOverride: picker.providerId }, effects.processEnrichmentAnswer],
  ['enrich/analyze-list', { category: 'favorite_books', items, ...picker }, effects.analyzeEnrichmentList],
  ['validate/contradictions', picker, effects.detectContradictions],
  ['analyze-writing', { samples: ['Example writing sample'], ...picker }, effects.analyzeWritingSamples],
  ['style/spoken-written', { spokenTranscript: 'Example transcript. '.repeat(10), ...picker }, effects.compareSpokenWrittenStyle],
  ['traits/analyze', picker, effects.analyzeTraits],
  ['confidence/calculate', picker, effects.calculateConfidence],
  ['interview/analyze', { content: 'Example assessment. '.repeat(5), ...picker }, effects.analyzeAssessment],
  ['tests/run', { ...picker, personaId }, effects.runTests],
  ['tests/run-multi', { providers: [picker], personaId }, effects.runTests],
  ['tests/generate', picker, effects.generateDynamicTests],
  ['values-tests/run', { ...picker, personaId }, effects.runValuesAlignmentTests],
  ['adversarial-tests/run', { ...picker, personaId }, effects.runAdversarialTests],
  ['multi-turn-tests/run', { ...picker, personaId }, effects.runMultiTurnTests],
  ['avatar-bio/polish', picker, effects.polishAvatarBio],
  ['import/analyze', { source: 'goodreads', data: 'Example import data', ...picker }, effects.analyzeImportedData],
  ['import/spotify/browser/import', picker, spotify.importSpotifyFromBrowser],
  ['twin-evidence/interpret', picker, evidence.interpretConsumption],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  for (const router of [enrichmentRoutes, analysisRoutes, testRoutes, avatarBioRoutes, importRoutes, evidenceRoutes, documentRoutes]) {
    app.use('/api/digital-twin', router);
  }
  app.use(errorMiddleware);
  return app;
};
const call = (app, path, body, headers = {}, method = 'post') => {
  const pending = request(app)[method]('/api/digital-twin/' + path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of [...Object.values(effects), ...Object.values(evidence), ...Object.values(spotify)]) {
    expect(effect).not.toHaveBeenCalled();
  }
};
beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Digital Twin process-capable AI authority (#10671)', () => {
  it('refuses remote anonymous operations before any effect, including API-first fallback and Express path variants', async () => {
    const app = appFor();
    for (const [path, body] of operations) {
      for (const candidate of [body, { ...body, providerId: 'example-api', providerOverride: 'example-api', providers: [{ providerId: 'example-api', model: picker.model }] }]) {
        const response = await call(app, path, candidate);
        expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      const variant = await call(app, path.toUpperCase() + '/', body);
      expect([variant.status, variant.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('refuses forwarded local, anonymous auth-on, Basic and scoped-peer requests before any effect', async () => {
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
      for (const [path, body] of operations) {
        const response = await call(app, path, body, headers);
        expect([response.status, response.body.code], path).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('preserves genuine local, operator-session and delegated-agent actions through real schemas', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      const app = appFor(address);
      for (const [path, body, effect] of operations) {
        const before = effect.mock.calls.length;
        const response = await call(app, path, body, headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
        expect(effect, path).toHaveBeenCalledTimes(before + 1);
      }
    }
    expect(effects.getPersonaById).toHaveBeenCalledTimes(15);
    expect(effects.analyzeWritingSamples).toHaveBeenLastCalledWith(['Example writing sample'], picker.providerId, picker.model);
  });

  it('preserves remote data editing, deterministic evidence recomputation, bounded vision and history', async () => {
    const app = appFor();
    for (const [method, path, body, effect, status] of [
      ['post', 'enrich/save-list', { category: 'favorite_books', content: 'Example content', items }, effects.saveEnrichmentListDocument, 200],
      ['post', 'documents', { filename: 'EXAMPLE.md', title: 'Example document', category: 'core', content: 'Example reference' }, effects.createDocument, 201],
      ['put', 'traits', { bigFive: { O: 0.5 } }, effects.updateTraits, 200],
      ['post', 'import/save', { source: 'goodreads', suggestedDoc: { filename: 'EXAMPLE.md', content: 'Example reference' } }, effects.saveImportAsDocument, 200],
      ['post', 'twin-evidence/recompute', {}, evidence.aggregateTwinEvidence, 200],
      ['post', 'identity/image', { imageDataUrl: 'data:image/png;base64,ZXhhbXBsZQ==', ...picker }, effects.analyzeIdentityImage, 200],
      ['get', 'tests/history', undefined, effects.getTestHistory, 200],
    ]) {
      const before = effect.mock.calls.length;
      const response = await call(app, path, body, {}, method);
      expect(response.status, path).toBe(status);
      expect(effect, path).toHaveBeenCalledTimes(before + 1);
    }
    for (const [, , effect] of operations) expect(effect).not.toHaveBeenCalled();
    expect(effects.getPersonaById).not.toHaveBeenCalled();
  });
});
