import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
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
vi.mock('../services/provider/providers.js', async (importOriginal) => ({
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

import { createSession } from '../services/auth.js';
import pipelineRoutes from './pipeline/index.js';
import { attachClient, isReverseOutlineActive } from '../services/pipeline/reverseOutline.js';

const mounts = [['/api/pipeline', pipelineRoutes]];
const operations = [
  [`/api/pipeline/series/${SERIES_ID}/reverse-outline/generate`, { providerId: cliProvider.id, force: true }],
  [`/api/pipeline/series/${SERIES_ID}/arc/generate`, { providerOverride: cliProvider.id }],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Pipeline generation never reaches a CLI provider for unauthorized callers (#10907)', () => {
  it('refuses a remote caller before the provider sink', async () => {
    // The reverse-outline run starts asynchronously; the harness's effect check
    // runs right after the 403, so give a leaked run a turn to reach the sink first.
    const [path, body] = operations[0];
    await expectRemoteRefusal(mounts, ['post', path, body, sink.runPromptThroughProvider]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('lets a local caller and a delegated agent session run the same operations on the chosen CLI provider', async () => {
    const operator = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        sink.runPromptThroughProvider.mockClear();
        const response = await callRoute(await hostControlApp(address, mounts), ['post', ...operation], headers);
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
        // The arc route awaits generateArcOverview (including runStagedLLM)
        // before res.json; only reverse-outline responds before dispatch.
        expect(sink.runPromptThroughProvider, operation[0]).toHaveBeenCalledTimes(1);
        expect(sink.runPromptThroughProvider.mock.calls[0][0].provider).toEqual(cliProvider);
      }
    }
  });
});
