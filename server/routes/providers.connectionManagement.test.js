/**
 * Boot reconciliation of a shared backend (#6369): the real `providerGraph`
 * service over a doubled store and toolkit. The HTTP edit routes this suite
 * once drove were removed in #18655; the reconcile pass is what remains.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = {
  readGraph: vi.fn(),
  applyServiceColumnBackfill: vi.fn().mockResolvedValue(undefined),
  applyReconciliation: vi.fn().mockResolvedValue(undefined),
  commitPendingProjection: vi.fn().mockResolvedValue(undefined),
  acknowledgeProjection: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn(),
  mergeServiceInstances: vi.fn().mockResolvedValue(undefined),
  saveConnectionSettings: vi.fn().mockResolvedValue(2),
};
vi.mock('../services/provider/providerGraphStore.js', () => store);

const providerService = {
  getAllProviders: vi.fn(),
  applyProviderPatches: vi.fn(),
  refreshProviderModelsBatch: vi.fn(),
};
// Partial: the routes module pulls the whole toolkit-state surface in through
// `services/provider/providers.js`, so only `requireToolkit` is doubled.
vi.mock('../lib/aiToolkitState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requireToolkit: () => ({ services: { providers: providerService } }),
}));

const graph = await import('../services/provider/providerGraph.js');

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const OTHER_CONNECTION = '22222222-2222-4222-8222-222222222222';
const CLAUDE_BINDING = '33333333-3333-4333-8333-333333333333';
const CODEX_BINDING = '44444444-4444-4444-8444-444444444444';

// One daemon, two protocol ports — the shape a local Ollama actually presents,
// and the reason a connection carries a transports MAP rather than one URL.
const DAEMON = 'http://127.0.0.1:11434';
const DAEMON_OPENAI = 'http://127.0.0.1:11434/v1';
const TOKEN = 'example-shared-token';
const OPENAI_KEY = 'example-openai-key';

// Two harnesses, three executable routes, ONE backend — the configuration this
// whole feature exists to stop a human from typing three times.
const CLAUDE_CLI = {
  id: 'claude-ollama',
  name: 'Claude',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  enabled: true,
  models: ['example-model'],
  defaultModel: 'example-model',
  envVars: { ANTHROPIC_BASE_URL: DAEMON, ANTHROPIC_AUTH_TOKEN: TOKEN },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
};
const CLAUDE_TUI = { ...CLAUDE_CLI, id: 'claude-ollama-tui', type: 'tui', enabled: false };
const CODEX_CLI = {
  id: 'codex-ollama',
  name: 'Codex',
  type: 'cli',
  command: 'codex',
  ollamaBacked: true,
  enabled: true,
  models: ['example-model'],
  // The same daemon, reached through its OpenAI-compatible port — a SECOND
  // harness on ONE connection, which is what makes a shared edit meaningful.
  envVars: { OPENAI_BASE_URL: DAEMON_OPENAI, OPENAI_API_KEY: OPENAI_KEY },
  secretEnvVars: ['OPENAI_API_KEY'],
};

const ownedSnapshot = () => ({
  fields: {},
  envVars: { ANTHROPIC_BASE_URL: DAEMON, ANTHROPIC_AUTH_TOKEN: TOKEN },
  hasEnvVars: true,
});
const codexOwnedSnapshot = () => ({
  fields: {},
  envVars: { OPENAI_BASE_URL: DAEMON_OPENAI, OPENAI_API_KEY: OPENAI_KEY },
  hasEnvVars: true,
});

const route = (providerId, bindingId, mode, projected = ownedSnapshot()) => ({
  providerId,
  bindingId,
  mode,
  modelMap: { 'example-model': 'example-model' },
  projected,
  pending: null,
  pendingRevision: null,
});

const graphFixture = () => ({
  connections: [
    {
      id: CONNECTION,
      revision: 3,
      kind: 'ollama',
      label: 'Example local daemon',
      transports: { anthropic: { baseUrl: DAEMON }, openai: { baseUrl: DAEMON_OPENAI } },
      credentials: { ANTHROPIC_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: OPENAI_KEY },
      catalog: { state: 'known', models: ['example-model', 'retired-model'] },
    },
    {
      id: OTHER_CONNECTION,
      revision: 1,
      kind: 'ollama',
      label: 'Remote daemon',
      transports: { anthropic: { baseUrl: 'https://ollama.example.com' } },
      credentials: {},
      catalog: { state: 'unknown', models: [] },
    },
  ],
  bindings: [
    {
      id: CLAUDE_BINDING, revision: 4, connectionId: CONNECTION, harnessId: 'claude',
      variantKey: 'default', label: 'Claude', enabled: true, selectedModels: ['example-model'],
    },
    {
      id: CODEX_BINDING, revision: 2, connectionId: CONNECTION, harnessId: 'codex',
      variantKey: 'default', label: 'Codex', enabled: false, selectedModels: [],
    },
  ],
  routes: [
    route('claude-ollama', CLAUDE_BINDING, 'cli'),
    route('claude-ollama-tui', CLAUDE_BINDING, 'tui'),
    route('codex-ollama', CODEX_BINDING, 'cli', codexOwnedSnapshot()),
  ],
});

beforeEach(async () => {
  vi.clearAllMocks();
  graph.resetProviderGraphState();
  store.readGraph.mockResolvedValue(graphFixture());
  store.saveConnectionSettings.mockResolvedValue(4);
  providerService.getAllProviders.mockResolvedValue({
    activeProvider: 'claude-ollama',
    providers: [structuredClone(CLAUDE_CLI), structuredClone(CLAUDE_TUI), structuredClone(CODEX_CLI)],
  });
  providerService.applyProviderPatches.mockImplementation(async (patches) => Object.keys(patches));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await graph.initProviderGraph();
  vi.clearAllMocks();
  store.readGraph.mockResolvedValue(graphFixture());
  store.saveConnectionSettings.mockResolvedValue(4);
  providerService.applyProviderPatches.mockImplementation(async (patches) => Object.keys(patches));
});

afterEach(() => vi.restoreAllMocks());

describe('boot reconciliation of the shared backend this suite edits', () => {
  it('leaves the two-protocol connection intact instead of cloning both bindings off it', async () => {
    // The fixture is the configuration the feature exists for: one daemon, two
    // protocol ports, two harnesses, one connection row. Each executable record
    // names ONE endpoint, so no route can ever report the row's full identity —
    // a reconcile pass that demanded equality would detach every binding onto a
    // fresh single-transport row and silently undo the link.
    graph.resetProviderGraphState();
    store.applyReconciliation.mockClear();

    await graph.initProviderGraph();

    expect(store.applyReconciliation).not.toHaveBeenCalled();
  });
});
