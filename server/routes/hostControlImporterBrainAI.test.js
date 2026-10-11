import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-importer-brain-ai-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Importer, Brain and analytics AI (#11036). Real routers behind the real auth
// + host-control gates; each AI service is doubled so no provider, run record
// or queue entry can start. The doubled service is the effect that must not run.
const auth = vi.hoisted(() => ({ enabled: false }));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/importer.js', async (importOriginal) => ({
  ...await importOriginal(),
  classifyImportContent: vi.fn(async () => ({ contentType: 'novel' })),
  analyzeImport: vi.fn(async () => ({ canon: {} })),
  retryIssueSplit: vi.fn(async () => ({ issues: [] })),
  commitImport: vi.fn(async () => ({ committed: true })),
}));
vi.mock('../services/brain.js', async (importOriginal) => ({
  ...await importOriginal(),
  captureThought: vi.fn(async () => ({})),
  retryClassification: vi.fn(async () => ({})),
  runDailyDigest: vi.fn(async () => ({})),
  runWeeklyReview: vi.fn(async () => ({})),
}));
vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn(async () => {}) }));
vi.mock('../services/activityDigest.js', async (importOriginal) => ({
  ...await importOriginal(),
  runDigestForDate: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/brainJournal.js', async (importOriginal) => ({
  ...await importOriginal(),
  getJournal: vi.fn(async () => null),
  appendJournal: vi.fn(async () => ({ id: 'example-entry' })),
}));
vi.mock('../services/modelPersonality.js', async (importOriginal) => ({
  ...await importOriginal(),
  runPersonalityTest: vi.fn(async () => ({})),
}));
vi.mock('../services/goalScorecard.js', async (importOriginal) => ({
  ...await importOriginal(),
  refreshScorecardNarrative: vi.fn(async () => ({})),
}));

import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import importerRoutes from './importer.js';
import brainCaptureRoutes from './brainCapture.js';
import brainDigestRoutes from './brainDigest.js';
import brainDailyLogRoutes from './brainDailyLog.js';
import modelPersonalityRoutes from './model-personality.js';
import insightsRoutes from './insights.js';
import { classifyImportContent, analyzeImport, retryIssueSplit, commitImport } from '../services/importer.js';
import { captureThought, retryClassification, runDailyDigest, runWeeklyReview } from '../services/brain.js';
import { runDigestForDate, updateSettings } from '../services/activityDigest.js';
import { appendJournal } from '../services/brainJournal.js';
import { runPersonalityTest } from '../services/modelPersonality.js';
import { refreshScorecardNarrative } from '../services/goalScorecard.js';

const picker = { providerOverride: 'example-cli', modelOverride: 'example-model' };
const source = 'Example manuscript text.';
const commitBody = {
  universeId: 'example-universe', seriesId: 'example-series', issues: [{ title: 'Example issue' }],
};
// [method, path, body, doubled service (the effect that must not run), success status]
const operations = [
  ['post', '/api/importer/classify', { source, ...picker }, classifyImportContent, 200],
  ['post', '/api/importer/analyze', {
    universeName: 'Example Universe', seriesName: 'Example Series', contentType: 'novel', source, ...picker,
  }, analyzeImport, 200],
  ['post', '/api/importer/retry-issues', { contentType: 'novel', source, ...picker }, retryIssueSplit, 200],
  ['post', '/api/importer/commit', { ...commitBody, cleanupFormatting: true }, commitImport, 200],
  ['post', '/api/brain/capture', { text: 'Example thought', ...picker }, captureThought, 200],
  ['post', '/api/brain/inbox/example-id/retry', picker, retryClassification, 200],
  ['post', '/api/brain/digest/run', picker, runDailyDigest, 200],
  ['post', '/api/brain/review/run', picker, runWeeklyReview, 200],
  ['post', '/api/brain/daily-log/2026-01-02/draft', {}, runDigestForDate, 200],
  ['put', '/api/brain/daily-log/digest-settings', { enabled: true, provider: 'example-cli', model: 'example-model' }, updateSettings, 200],
  ['post', '/api/model-personality/run', { providerId: 'example-cli', includeAlignment: true }, runPersonalityTest, 200],
  ['post', '/api/insights/goal-scorecard/narrative', { providerId: 'example-cli' }, refreshScorecardNarrative, 200],
];
// Distinct services touched by the table, so the "never ran" check covers each once.
const sinks = [...new Set(operations.map(([, , , service]) => service))];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/importer', importerRoutes);
  app.use('/api/brain', brainCaptureRoutes, brainDigestRoutes, brainDailyLogRoutes);
  app.use('/api/model-personality', modelPersonalityRoutes);
  app.use('/api/insights', insightsRoutes);
  app.use(errorMiddleware);
  return app;
};
const send = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const service of sinks) expect(service).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Importer, Brain and analytics AI operator authority (#11036)', () => {
  it('refuses a remote password-free caller, including spoofed-proxy variants, before any effect', async () => {
    for (const operation of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const response = await send(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password, denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status] of [
        [{}, 401],
        [{ Authorization: 'Bearer invalid-session' }, 401],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403],
      ]) {
        const response = await send(appFor(), operation, headers);
        expect(response.status, operation[1]).toBe(status);
        if (status === 401) expect(response.body.code, operation[1]).toBe('AUTH_REQUIRED');
      }
    }
    expectNoEffects();
  });

  it('matches case and trailing-slash variants before any effect', async () => {
    for (const [method, path, body] of operations) {
      const response = await send(appFor(), [method, path.toUpperCase() + '/', body]);
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${agent.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await send(appFor(address), operation, headers);
        expect(response.status, `${operation[1]}: ${JSON.stringify(response.body)}`).toBe(operation[4]);
      }
    }
    for (const service of sinks) expect(service).toHaveBeenCalled();
  });

  it('gates Importer commit only when cleanupFormatting is true', async () => {
    const remote = appFor('192.0.2.10');
    for (const body of [commitBody, { ...commitBody, cleanupFormatting: false }]) {
      const response = await send(remote, ['post', '/api/importer/commit', body]);
      expect(response.status, JSON.stringify(body)).toBe(200);
    }
    expect(commitImport).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    const refused = await send(remote, ['post', '/api/importer/commit', { ...commitBody, cleanupFormatting: true }]);
    expect([refused.status, refused.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(commitImport).not.toHaveBeenCalled();
  });

  it('leaves record reads and Brain daily-log CRUD open to a remote caller', async () => {
    const remote = appFor();
    expect((await request(remote).get('/api/importer/config')).status).toBe(200);
    const append = await send(remote, ['post', '/api/brain/daily-log/2026-01-02/append', { text: 'Example entry' }]);
    expect(append.status).toBe(200);
    expect(appendJournal).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });
});
