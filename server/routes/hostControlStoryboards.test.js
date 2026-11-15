import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
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

const { authGate, hostControlRouteGate } = await import('../services/authGate.js');
const { createSession } = await import('../services/auth.js');
const { correctPanel, drawPanel, runPanelNode, startMakeEmpty } = await import('../services/storyboards/make.js');
const { default: storyboardRoutes } = await import('./storyboards.js');

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

// Board creation is a write, so only an authorized (here local) caller can create it.
const newBoard = async () => {
  const created = await post(appFor('127.0.0.1'), '/api/storyboards', { name: 'Example Story' });
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
  it('refuses a remote password-free caller, before any provider call or render', async () => {
    const id = await newBoard();
    for (const [path, body] of operations(id)) {
      const response = await post(appFor(), path, body);
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('keeps working for local callers and delegated agent sessions', async () => {
    const id = await newBoard();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path, body, status] of operations(id)) {
        const response = await post(appFor(address), path, body, headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
      }
    }
    expect(sink.runPromptThroughProvider).toHaveBeenCalledTimes(2);
    expect(sink.runPromptThroughProvider.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: cliProvider, source: 'storyboard-plot-beats',
    }));
    expect(runPanelNode).toHaveBeenCalledTimes(2);
    expect(correctPanel).toHaveBeenCalledTimes(2);
    expect(drawPanel).toHaveBeenCalledTimes(2);
    expect(startMakeEmpty).toHaveBeenCalledTimes(2);
  });
});
