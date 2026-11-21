import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-storyboards-host-control-') }));
afterAll(cleanupTempDataRoots);

// Storyboards agent runs (#12952). Real router behind the real auth and
// host-control gates. Beat extraction runs for real up to the provider sink,
// so a synthetic CLI provider proves the gate stands before
// `runPromptThroughProvider`; the panel maker's run, correction and make-empty services are
// doubled, so neither a provider call nor an image job can start.
const auth = vi.hoisted(() => ({ enabled: false }));
const cliProvider = vi.hoisted(() => ({
  id: 'example-cli', name: 'Example CLI', type: 'cli', enabled: true, command: 'example-agent', args: [], defaultModel: 'example-model',
}));
const sink = vi.hoisted(() => ({
  runPromptThroughProvider: vi.fn(async () => ({ text: '{"beats":[{"title":"Arrival","panels":[{"action":"Wide of the doors"}]}]}' })),
  enqueueJob: vi.fn(async () => ({ jobId: 'job-example' })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/promptRunner.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveProviderAndModel: vi.fn(async () => ({ provider: cliProvider, selectedModel: 'example-model' })),
  runPromptThroughProvider: sink.runPromptThroughProvider,
}));
vi.mock('../services/mediaJobQueue/index.js', async (importOriginal) => ({
  ...await importOriginal(),
  enqueueJob: sink.enqueueJob,
}));
vi.mock('../services/storyboards/make.js', async (importOriginal) => ({
  ...await importOriginal(),
  runPanelNode: vi.fn(async () => ({ ok: true })),
  correctPanel: vi.fn(async () => ({ ok: true })),
  drawPanel: vi.fn(async () => ({ ok: true })),
  startMakeEmpty: vi.fn(async () => ({ status: 'running' })),
}));

const { correctPanel, drawPanel, runPanelNode, startMakeEmpty } = await import('../services/storyboards/make.js');
const { default: storyboardRoutes } = await import('./storyboards.js');

// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js; this keeps one refusal (before the provider sink)
// and the authorized workflow for each agent-run route.
const mounts = [['/api/storyboards', storyboardRoutes]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Storyboards agent runs behind the default-deny gate (#12952, #16114)', () => {
  it('refuses a remote caller before the provider call, and still runs every route for local and agent callers', async () => {
    // Board creation is a write, so only an authorized (here local) caller can create it.
    const created = await callRoute(await hostControlApp('127.0.0.1', mounts), ['post', '/api/storyboards', { name: 'Example Story' }]);
    expect(created.status).toBe(201);
    const id = created.body.id;
    const beats = `/api/storyboards/${id}/beats/extract`;
    const beatsBody = { plot: 'Example plot', providerId: cliProvider.id };
    await expectRemoteRefusal(mounts, ['post', beats, beatsBody, sink.runPromptThroughProvider]);
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', beats, beatsBody, sink.runPromptThroughProvider, 200],
      ['post', `/api/storyboards/${id}/panels/panel-example/make/node-example/run`, {}, runPanelNode, 200],
      ['post', `/api/storyboards/${id}/panels/panel-example/correct`, { takeId: 'take-example', note: 'Wider' }, correctPanel, 200],
      ['post', `/api/storyboards/${id}/panels/panel-example/draw`, {}, drawPanel, 200],
      ['post', `/api/storyboards/${id}/make-empty`, {}, startMakeEmpty, 202],
    ] });
    expect(sink.runPromptThroughProvider.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: cliProvider, source: 'storyboard-plot-beats',
    }));
  });
});
