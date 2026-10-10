import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pipeline-dispatch-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());

// Real Pipeline routes, real stage runner, real auth gates (#10907). Only the
// edges are doubled: the provider registry (one synthetic CLI provider), the
// prompt renderer, run-record creation, the series record, and the provider
// execution itself. `runPromptThroughProvider` is the sink the audit named, so
// a refused request must leave it untouched and an authorized one must reach it
// with the CLI provider the caller picked.
const auth = vi.hoisted(() => ({ enabled: false }));
const cliProvider = vi.hoisted(() => ({
  id: 'example-cli', name: 'Example CLI', type: 'cli', enabled: true, command: 'example-agent', args: [], defaultModel: 'example-model',
}));
const sink = vi.hoisted(() => ({
  runPromptThroughProvider: vi.fn(async () => ({ text: '{"logline":"Example","scenes":[],"plotlines":[]}' })),
}));
const SERIES_ID = 'ser-00000000-0000-4000-8000-000000000001';

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/providers.js', async (importOriginal) => ({
  ...await importOriginal(),
  getProviderById: vi.fn(async (providerId) => (providerId === cliProvider.id ? cliProvider : null)),
  getActiveProvider: vi.fn(async () => cliProvider),
}));
vi.mock('../services/promptService.js', async (importOriginal) => ({
  ...await importOriginal(),
  buildPrompt: vi.fn(async () => 'Example rendered prompt'),
  getStage: vi.fn(() => ({})),
}));
vi.mock('../services/runner.js', async (importOriginal) => ({
  ...await importOriginal(),
  createRun: vi.fn(async () => ({ runId: 'example-run-0001' })),
  patchRunMetadata: vi.fn(async () => undefined),
}));
vi.mock('../services/promptRunner.js', async (importOriginal) => ({
  ...await importOriginal(),
  runPromptThroughProvider: sink.runPromptThroughProvider,
}));
vi.mock('../services/pipeline/series.js', async (importOriginal) => ({
  ...await importOriginal(),
  getSeries: vi.fn(async (id) => ({ id, name: 'Example Series', locked: {} })),
}));
vi.mock('../services/pipeline/arcPlanner/context.js', async (importOriginal) => ({
  ...await importOriginal(),
  buildArcOverviewContext: vi.fn(async () => ({})),
}));
vi.mock('../services/pipeline/arcPlanner.js', async (importOriginal) => ({
  ...await importOriginal(),
  collectManuscriptSections: vi.fn(async () => [
    { issueId: 'example-issue', number: 1, title: 'One', stageId: 'prose', content: 'Example prose.' },
  ]),
}));
vi.mock('../services/pipeline/seriesCanon.js', async (importOriginal) => ({
  ...await importOriginal(),
  getSeriesCanon: vi.fn(async () => ({ characters: [] })),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import pipelineRoutes from './pipeline/index.js';
import { attachClient, isReverseOutlineActive } from '../services/pipeline/reverseOutline.js';

const operations = [
  [`/api/pipeline/series/${SERIES_ID}/reverse-outline/generate`, { providerId: cliProvider.id, force: true }],
  [`/api/pipeline/series/${SERIES_ID}/arc/generate`, { providerOverride: cliProvider.id }],
];
const appFor = (address) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/pipeline', pipelineRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Pipeline generation never reaches a CLI provider for unauthorized callers (#10907)', () => {
  it('refuses a remote password-free caller and a legacy Basic holder before the provider sink', async () => {
    for (const operation of operations) {
      const remote = await post(appFor('192.0.2.10'), operation);
      expect([remote.status, remote.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    auth.enabled = true;
    for (const operation of operations) {
      const basic = await post(appFor('192.0.2.10'), operation, {
        Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64'),
      });
      expect([basic.status, basic.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    // An in-flight reverse-outline run starts asynchronously; give it a turn to
    // reach the sink if the gate had let it through.
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('lets a local caller and an operator session run the same operations on the chosen CLI provider', async () => {
    const operator = await createSession();
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        sink.runPromptThroughProvider.mockClear();
        const response = await post(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(200);
        if (operation[0].includes('/reverse-outline/')) {
          // A provider call is not completion: persistence is still in flight.
          // Await the public SSE terminal frame (including its late replay) so
          // the next local/operator request cannot reuse the previous run.
          const connection = new EventEmitter();
          try {
            const terminal = await new Promise((resolve) => {
              expect(attachClient(SERIES_ID, {
                req: connection,
                writeHead() {},
                end() {},
                write(frame) {
                  const payload = JSON.parse(frame.slice('data: '.length));
                  if (['complete', 'error', 'canceled'].includes(payload.type)) resolve(payload);
                },
              })).toBe(true);
            });
            expect(terminal).toMatchObject({ type: 'complete', runId: response.body.runId });
            // The coordinator marks the run finished after broadcasting.
            await new Promise((resolve) => setImmediate(resolve));
            expect(isReverseOutlineActive(SERIES_ID)).toBe(false);
          } finally {
            connection.emit('close');
          }
        }
        expect(sink.runPromptThroughProvider, operation[0]).toHaveBeenCalledTimes(1);
        expect(sink.runPromptThroughProvider.mock.calls[0][0].provider).toEqual(cliProvider);
      }
    }
  });
});
