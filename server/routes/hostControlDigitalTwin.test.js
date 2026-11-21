import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real gates, mounted routers and schemas. Stub the first service boundaries:
// refusal must happen before private reads, document writes or provider dispatch.
// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js; this keeps one refusal and every authorized workflow.
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

import express from 'express';
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
  // Opens a tab in the operator's signed-in managed browser (#13055).
  ['import/spotify/browser/open', {}, spotify.openSpotifyBrowser],
  ['twin-evidence/interpret', picker, evidence.interpretConsumption],
];

const mounts = [[
  '/api/digital-twin',
  express.Router().use(enrichmentRoutes, analysisRoutes, testRoutes, avatarBioRoutes, importRoutes, evidenceRoutes, documentRoutes),
]];
const writes = [
  ['enrich/save-list', { category: 'favorite_books', content: 'Example content', items }, effects.saveEnrichmentListDocument, 200, 'post'],
  ['documents', { filename: 'EXAMPLE.md', title: 'Example document', category: 'core', content: 'Example reference' }, effects.createDocument, 201, 'post'],
  ['traits', { bigFive: { O: 0.5 } }, effects.updateTraits, 200, 'put'],
  ['import/save', { source: 'goodreads', suggestedDoc: { filename: 'EXAMPLE.md', content: 'Example reference' } }, effects.saveImportAsDocument, 200, 'post'],
  ['twin-evidence/recompute', {}, evidence.aggregateTwinEvidence, 200, 'post'],
  ['identity/image', { imageDataUrl: 'data:image/png;base64,ZXhhbXBsZQ==', ...picker }, effects.analyzeIdentityImage, 200, 'post'],
];
const workflows = [
  ...operations.map(([path, body, effect]) => ['post', `/api/digital-twin/${path}`, body, effect, 200]),
  ...writes.map(([path, body, effect, status, method]) => [method, `/api/digital-twin/${path}`, body, effect, status]),
];
beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Digital Twin writes and process-capable AI behind the default-deny gate (#10671, #16114)', () => {
  it('refuses a remote caller before any effect', async () => {
    const [path, body, effect] = operations[0];
    await expectRemoteRefusal(mounts, ['post', `/api/digital-twin/${path}`, body, effect]);
    const [writePath, writeBody, writeEffect, , method] = writes[0];
    await expectRemoteRefusal(mounts, [method, `/api/digital-twin/${writePath}`, writeBody, writeEffect]);
  });

  it('still runs every AI operation and document write for a local operator and an agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.analyzeWritingSamples).toHaveBeenLastCalledWith(['Example writing sample'], picker.providerId, picker.model);
  });
});
