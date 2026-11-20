import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

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
const mounts = [
  ['/api/importer', importerRoutes],
  ['/api/brain', brainCaptureRoutes],
  ['/api/brain', brainDigestRoutes],
  ['/api/brain', brainDailyLogRoutes],
  ['/api/model-personality', modelPersonalityRoutes],
  ['/api/insights', insightsRoutes],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js; this keeps one refusal and every authorized workflow.
describe('Importer, Brain and analytics AI behind the default-deny gate (#11036, #16114)', () => {
  it('refuses a remote caller before any effect', async () => {
    const [method, path, body, effect] = operations[0];
    await expectRemoteRefusal(mounts, [method, path, body, effect]);
  });

  it('keeps every AI operation and Brain daily-log write working for local callers and agent sessions', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ...operations,
      ['post', '/api/brain/daily-log/2026-01-02/append', { text: 'Example entry' }, appendJournal, 200],
    ] });
  });
});
