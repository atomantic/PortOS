import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { scanRouteGraph } from '../lib/apiRouteGraph.js';
import { isHostControlRoute } from '../lib/hostControlRoutes.js';

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

const { authGate, hostControlRouteGate } = await import('../services/authGate.js');
const { createSession } = await import('../services/auth.js');
const { correctPanel, drawPanel, runPanelNode, startMakeEmpty } = await import('../services/storyboards/make.js');
const { default: storyboardRoutes } = await import('./storyboards.js');

const GATED = [
  'POST /api/storyboards/:id/beats/extract',
  'POST /api/storyboards/:id/make-empty',
  'POST /api/storyboards/:id/panels/:panelId/correct',
  'POST /api/storyboards/:id/panels/:panelId/draw',
  'POST /api/storyboards/:id/panels/:panelId/make/:nodeId/run',
];
const effects = [sink.runPromptThroughProvider, sink.enqueueJob, runPanelNode, correctPanel, drawPanel, startMakeEmpty];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/storyboards', storyboardRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, path, body = {}, headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

// A remote password-free caller can still create the board the runs act on.
const newBoard = async () => {
  const created = await post(appFor(), '/api/storyboards', { name: 'Example Story' });
  expect(created.status).toBe(201);
  return created.body.id;
};
const operations = (id) => [
  [`/api/storyboards/${id}/beats/extract`, { plot: 'Example plot', providerId: cliProvider.id }, 200],
  [`/api/storyboards/${id}/panels/panel-example/make/node-example/run`, {}, 200],
  [`/api/storyboards/${id}/panels/panel-example/correct`, { takeId: 'take-example', note: 'Wider' }, 200],
  [`/api/storyboards/${id}/panels/panel-example/draw`, {}, 200],
  [`/api/storyboards/${id}/make-empty`, {}, 202],
];
const expectNoEffects = () => {
  for (const effect of effects) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Storyboards agent runs require operator authority (#12952)', () => {
  it('gates exactly the five runs; every other Storyboards mutation stores records and stays open', () => {
    const mutations = scanRouteGraph().routes
      .filter((route) => route.mountPath === '/api/storyboards' && route.method !== 'GET')
      .map(({ method, path }) => `${method} ${path}`);
    expect(mutations.filter((route) => isHostControlRoute(...route.split(' '))).sort()).toEqual(GATED);
    expect(mutations.filter((route) => !isHostControlRoute(...route.split(' '))).sort()).toEqual([
      'DELETE /api/storyboards/:id',
      'DELETE /api/storyboards/:id/beats/:beatId',
      'DELETE /api/storyboards/:id/panels/:panelId',
      'DELETE /api/storyboards/:id/panels/:panelId/takes/:takeId',
      'DELETE /api/storyboards/recipes/:recipeId',
      'PATCH /api/storyboards/:id',
      'PATCH /api/storyboards/:id/beats/:beatId',
      'PATCH /api/storyboards/:id/panels/:panelId',
      'PATCH /api/storyboards/:id/panels/:panelId/make/:nodeId',
      'POST /api/storyboards',
      'POST /api/storyboards/:id/beats',
      'POST /api/storyboards/:id/beats/:beatId/move',
      'POST /api/storyboards/:id/beats/:beatId/panels',
      'POST /api/storyboards/:id/beats/add',
      'POST /api/storyboards/:id/panels/:panelId/move',
      'POST /api/storyboards/:id/panels/:panelId/scene-art',
      'POST /api/storyboards/:id/panels/:panelId/takes',
      'POST /api/storyboards/:id/panels/:panelId/takes/:takeId/select',
      'POST /api/storyboards/:id/video',
      'POST /api/storyboards/fit-music-video/:projectId',
      'POST /api/storyboards/from-fableloom/:loomId/:episodeId',
      'POST /api/storyboards/from-music-video/:projectId',
      'POST /api/storyboards/from-pipeline/:issueId',
      'POST /api/storyboards/group-by-song/:projectId',
      'POST /api/storyboards/music-video/:projectId/shots/:sceneId/panel-art',
      'POST /api/storyboards/music-video/:projectId/shots/:sceneId/update-from-panel',
      'POST /api/storyboards/pipeline/:issueId/update-from-board',
      'POST /api/storyboards/recipes',
      'POST /api/storyboards/sync-music-video/:projectId',
      'PUT /api/storyboards/:id/recipe',
      'PUT /api/storyboards/sync-music-video/:projectId/auto',
    ]);
  });

  it('refuses a remote password-free caller, including spoofed-proxy variants and path spellings, before any provider call or render', async () => {
    const id = await newBoard();
    for (const [path, body] of operations(id)) {
      for (const [address, headers, spelling] of [
        ['192.0.2.10', {}, path],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, path],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }, path],
        ['192.0.2.10', {}, `${path.toUpperCase()}/`],
      ]) {
        const response = await post(appFor(address), spelling, body, headers);
        expect([response.status, response.body.code], spelling).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const id = await newBoard();
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path, body, status] of operations(id)) {
        const response = await post(appFor(address), path, body, headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
      }
    }
    expect(sink.runPromptThroughProvider).toHaveBeenCalledTimes(3);
    expect(sink.runPromptThroughProvider.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: cliProvider, source: 'storyboard-plot-beats',
    }));
    expect(runPanelNode).toHaveBeenCalledTimes(3);
    expect(correctPanel).toHaveBeenCalledTimes(3);
    expect(drawPanel).toHaveBeenCalledTimes(3);
    expect(startMakeEmpty).toHaveBeenCalledTimes(3);
  });
});
