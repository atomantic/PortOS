/**
 * Creating a backend and a harness on it, end to end (#6369): real Express
 * route → real Zod schema → the real `providerGraph` service → a doubled store
 * and toolkit.
 *
 * This is the half of connection management that ADDS rather than edits, and it
 * was blocked until `PROVIDER_HARNESSES` carried a command recipe — the
 * registry could classify a record it was handed but not describe how to spawn
 * a fresh one. The regressions worth pinning are therefore about what a minted
 * route IS:
 *
 *   - it runs the harness's shipped, proven command line;
 *   - it reaches the backend it was created on, and DESCRIBES that backend, so
 *     the next reconciliation pass does not clone it onto a connection of its
 *     own;
 *   - it arrives disabled, unpinned and unconsented — creating a route is not
 *     granting execution;
 *   - nothing is probed, generated or launched by any of it.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { providerConnectionProfile, sameConnectionIdentity } from '../lib/providerConnections.js';
import { planGraphReconciliation, reconciliationIsNoop } from '../lib/providerGraphRecords.js';

const store = {
  readGraph: vi.fn(),
  writeGraph: vi.fn().mockResolvedValue(undefined),
  applyReconciliation: vi.fn().mockResolvedValue(undefined),
  commitPendingProjection: vi.fn().mockResolvedValue(undefined),
  acknowledgeProjection: vi.fn().mockResolvedValue(undefined),
  relinkBinding: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn(),
  detachBindingToConnection: vi.fn().mockResolvedValue(undefined),
  saveConnectionSettings: vi.fn().mockResolvedValue(2),
  saveBindingSettings: vi.fn().mockResolvedValue(2),
  saveRouteModelMap: vi.fn().mockResolvedValue(undefined),
  saveRouteModelAliases: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../services/providerGraphStore.js', () => store);

const providerService = {
  getAllProviders: vi.fn(),
  createProvider: vi.fn(),
  applyProviderPatches: vi.fn(),
  refreshProviderModelsBatch: vi.fn(),
};
vi.mock('../lib/aiToolkitState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requireToolkit: () => ({ services: { providers: providerService } }),
}));

const graph = await import('../services/providerGraph.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

const OLLAMA_ANTHROPIC = '11111111-1111-4111-8111-111111111111';
const OLLAMA_OPENAI = '22222222-2222-4222-8222-222222222222';
const KEYLESS = '33333333-3333-4333-8333-333333333333';
const MULTI = '44444444-4444-4444-8444-444444444444';
const BLOCKED = '66666666-6666-4666-8666-666666666666';
const BLOCKED_BINDING = '77777777-7777-4777-8777-777777777777';

const DAEMON = 'http://127.0.0.1:11434';
const DAEMON_OPENAI = 'http://127.0.0.1:11434/v1';
const TOKEN = 'example-local-token';

const connection = (id, overrides) => ({
  id,
  revision: 1,
  kind: 'ollama',
  label: 'Example local daemon',
  transports: { anthropic: { baseUrl: DAEMON } },
  credentials: { ANTHROPIC_AUTH_TOKEN: TOKEN },
  catalog: { state: 'known', models: ['example-model'] },
  ...overrides,
});

const graphFixture = () => ({
  connections: [
    connection(OLLAMA_ANTHROPIC),
    connection(OLLAMA_OPENAI, { transports: { openai: { baseUrl: DAEMON_OPENAI } }, credentials: {} }),
    connection(KEYLESS, { credentials: {} }),
    connection(MULTI, {
      transports: { anthropic: { baseUrl: DAEMON }, openai: { baseUrl: DAEMON_OPENAI } },
    }),
    connection(BLOCKED),
  ],
  bindings: [{
    id: BLOCKED_BINDING, revision: 1, connectionId: BLOCKED, harnessId: 'claude',
    variantKey: 'default', label: 'Claude', enabled: false, selectedModels: [],
  }],
  // A route whose projection was committed but not yet acknowledged: the graph
  // and providers.json disagree about this backend until it settles.
  routes: [{
    providerId: EXISTING.id, bindingId: BLOCKED_BINDING, mode: 'cli', modelMap: {}, modelAliasOverrides: {},
    projected: {}, pending: { fields: {}, envVars: {}, hasEnvVars: true }, pendingRevision: 2,
  }],
});

// One record already on the install, so id minting has something to collide with.
const EXISTING = {
  id: 'claude-ollama',
  name: 'Claude',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  enabled: true,
  models: [],
  envVars: { ANTHROPIC_BASE_URL: DAEMON, ANTHROPIC_AUTH_TOKEN: TOKEN },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
};

function app() {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
}

/** The records `createProvider` was handed, keyed by id. */
const created = () => new Map(providerService.createProvider.mock.calls.map(([record]) => [record.id, record]));

beforeEach(async () => {
  vi.clearAllMocks();
  graph.resetProviderGraphState();
  store.readGraph.mockResolvedValue(graphFixture());
  // The toolkit persists what it is handed; the service reads the file back to
  // build its `projected` snapshot, so the double has to behave that way too.
  const persisted = new Map([[EXISTING.id, structuredClone(EXISTING)]]);
  providerService.createProvider.mockImplementation(async (record) => {
    persisted.set(record.id, structuredClone(record));
    return record;
  });
  providerService.getAllProviders.mockImplementation(async () => ({
    activeProvider: EXISTING.id,
    providers: [...persisted.values()].map((provider) => structuredClone(provider)),
  }));
  providerService.applyProviderPatches.mockImplementation(async (patches) => Object.keys(patches));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await graph.initProviderGraph();
  store.writeGraph.mockClear();
  providerService.createProvider.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('POST /api/providers/connections', () => {
  it('stores a backend with an unknown catalog and no route, and publishes no secret', async () => {
    const res = await request(app()).post('/api/providers/connections').send({
      kind: 'api',
      label: 'Remote example daemon',
      transports: { openai: { baseUrl: 'https://ollama.example.com/v1' } },
      credentials: { apiKey: 'example-remote-key' },
    });

    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({
      kind: 'api',
      label: 'Remote example daemon',
      hasCredentials: true,
      // Never asked, so never claimed: `[]` would say the backend has no models.
      catalog: { state: 'unknown', models: [] },
    });
    expect(JSON.stringify(res.body)).not.toContain('example-remote-key');

    const [written] = store.writeGraph.mock.calls.at(-1);
    expect(written.connections).toHaveLength(1);
    expect(written.bindings).toHaveLength(0);
    expect(written.routes).toHaveLength(0);
    // Creating a backend contacts nothing and mints nothing.
    expect(providerService.refreshProviderModelsBatch).not.toHaveBeenCalled();
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it('refuses a backend kind no minted route could honestly describe', async () => {
    const res = await request(app()).post('/api/providers/connections').send({
      kind: 'vendor',
      label: 'Anything',
      transports: { openai: { baseUrl: 'https://example.com/v1' } },
    });
    expect(res.status).toBe(400);
    expect(store.writeGraph).not.toHaveBeenCalled();
  });

  it('refuses a backend declaring two transports, which its own routes could never match', async () => {
    const res = await request(app()).post('/api/providers/connections').send({
      kind: 'ollama',
      label: 'Two ports',
      transports: { anthropic: { baseUrl: DAEMON }, openai: { baseUrl: DAEMON_OPENAI } },
    });
    expect(res.status).toBe(400);
    expect(store.writeGraph).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/bindings', () => {
  it('mints both modes from the harness recipe, disabled, on ids that keep the CLI/TUI pairing', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: OLLAMA_ANTHROPIC, harnessId: 'claude', modes: ['cli', 'tui'] });

    expect(res.status).toBe(201);
    // `claude-ollama` is already taken, so the whole set moves together rather
    // than each id being uniquified on its own — otherwise the `-tui` stem
    // relationship the toolkit pairs modes by would break.
    expect(res.body.routeIds).toEqual(['claude-ollama-2', 'claude-ollama-2-tui']);
    expect(res.body.enabled).toBe(false);

    const records = created();
    expect(records.get('claude-ollama-2')).toMatchObject({
      type: 'cli',
      command: 'claude',
      args: ['--print'],
      headlessArgs: ['--no-session-persistence', '--disable-slash-commands', '--tools', ''],
      enabled: false,
      models: [],
      defaultModel: null,
      // The backend marker is what gives the route its model refresh and, for
      // OpenCode, its namespace prefix.
      ollamaBacked: true,
      envVars: { ANTHROPIC_BASE_URL: DAEMON, ANTHROPIC_AUTH_TOKEN: TOKEN },
      secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
    });
    expect(records.get('claude-ollama-2-tui')).toMatchObject({
      type: 'tui',
      args: ['--dangerously-skip-permissions'],
      tuiPromptDelayMs: 2500,
      enabled: false,
    });
    // Creating a route is not granting execution: no consent flag is set here,
    // and no mode opt-in rides along.
    for (const record of records.values()) {
      expect(record).not.toHaveProperty('textTransportEnabled');
      expect(record).not.toHaveProperty('allowCustomEndpoint');
    }
    // Nothing is probed, generated or launched by a create.
    expect(providerService.refreshProviderModelsBatch).not.toHaveBeenCalled();
  });

  it('stores a disabled binding whose routes already describe the backend they were minted on', async () => {
    await request(app()).post('/api/providers/bindings')
      .send({ connectionId: OLLAMA_ANTHROPIC, harnessId: 'claude', modes: ['cli', 'tui'] });

    const [written] = store.writeGraph.mock.calls.at(-1);
    expect(written.bindings[0]).toMatchObject({
      connectionId: OLLAMA_ANTHROPIC, harnessId: 'claude', variantKey: 'default', enabled: false, selectedModels: [],
    });
    expect(written.routes.map((route) => route.mode)).toEqual(['cli', 'tui']);
    // `projected` is read back off what the toolkit actually wrote, so the row
    // and providers.json start in agreement and the reconcile this write
    // triggers has nothing to repair.
    for (const route of written.routes) {
      expect(route.pending).toBeNull();
      expect(route.projected.envVars).toEqual({ ANTHROPIC_BASE_URL: DAEMON, ANTHROPIC_AUTH_TOKEN: TOKEN });
    }
    // The load-bearing invariant: a minted route reports the SAME connection
    // identity as the row it was created on. Anything else and reconciliation
    // clones the binding onto a connection of its own on the next pass.
    const record = created().get(written.routes[0].providerId);
    expect(sameConnectionIdentity(
      providerConnectionProfile(record),
      { kind: 'ollama', transports: { anthropic: { baseUrl: DAEMON } }, credentials: { ANTHROPIC_AUTH_TOKEN: TOKEN } },
    )).toBe(true);
  });

  it('mints an OpenCode route whose inline config names the backend and namespace', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: OLLAMA_OPENAI, harnessId: 'opencode', modes: ['cli'] });

    expect(res.status).toBe(201);
    const record = created().get(res.body.routeIds[0]);
    expect(record.command).toBe('opencode');
    expect(record.args).toEqual(['run']);
    const config = JSON.parse(record.envVars.OPENCODE_CONFIG_CONTENT);
    expect(config.provider.ollama.options.baseURL).toBe(DAEMON_OPENAI);
  });

  it('mints a direct API route with no harness and no command', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: OLLAMA_OPENAI, harnessId: null, modes: ['api'] });

    expect(res.status).toBe(201);
    const record = created().get(res.body.routeIds[0]);
    expect(record).toMatchObject({ type: 'api', endpoint: DAEMON_OPENAI, enabled: false });
    expect(record.command).toBeUndefined();
  });

  it('refuses a harness that reaches only its own vendor service', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: OLLAMA_ANTHROPIC, harnessId: 'cursor', modes: ['cli'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROVIDER_HARNESS_NOT_CREATABLE');
    expect(providerService.createProvider).not.toHaveBeenCalled();
    expect(store.writeGraph).not.toHaveBeenCalled();
  });

  it('refuses a backend whose transport the harness does not speak', async () => {
    // The half of the transport rule that did NOT relax: this row declares the
    // openai wire and nothing else, so a Claude route on it would name an
    // endpoint the backend does not serve.
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: OLLAMA_OPENAI, harnessId: 'claude', modes: ['cli'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_TRANSPORT_MISMATCH');
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it('mints a route on a backend that declares a SECOND protocol for another harness', async () => {
    // One Ollama daemon reached by Claude on its Anthropic port and by an
    // OpenAI-compatible harness on `/v1` is ONE backend. A provider record
    // names one endpoint, so this route describes only the anthropic half —
    // #6452 made reconciliation judge that by CONTAINMENT, which is what lets
    // the create through instead of refusing it (#6460).
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: MULTI, harnessId: 'claude', modes: ['cli'] });

    expect(res.status).toBe(201);
    const record = created().get(res.body.routeIds[0]);
    // The harness's OWN transport, and only it: the record carries no trace of
    // the protocol the other harness on this backend speaks.
    expect(record.envVars).toEqual({ ANTHROPIC_BASE_URL: DAEMON, ANTHROPIC_AUTH_TOKEN: TOKEN });
    expect(record.endpoint).toBe(DAEMON);
    expect(record.envVars).not.toHaveProperty('OPENAI_BASE_URL');
    expect(record.envVars).not.toHaveProperty('OPENAI_API_KEY');
    expect(record.secretEnvVars).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });

  it('leaves that cross-protocol binding untouched through a reconciliation pass', async () => {
    // The property #6452 established and this create depends on: a route the
    // stored connection CONTAINS stays on it, rather than being cloned onto a
    // single-transport connection of its own on the very next pass.
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: MULTI, harnessId: 'claude', modes: ['cli'] });
    const [written] = store.writeGraph.mock.calls.at(-1);

    const plan = planGraphReconciliation(
      { connections: graphFixture().connections, bindings: written.bindings, routes: written.routes },
      [created().get(res.body.routeIds[0])],
    );

    expect(reconciliationIsNoop(plan)).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.regroups).toHaveLength(1);
    expect(plan.regroups[0]).toMatchObject({
      bindingId: written.bindings[0].id,
      connectionAction: 'unchanged',
      // Republished AS STORED — narrowing the row to this route's single
      // transport would strand the other harness on it.
      connection: { id: MULTI, transports: { anthropic: { baseUrl: DAEMON }, openai: { baseUrl: DAEMON_OPENAI } } },
    });
  });

  it('refuses a Claude route on a backend with no auth token rather than minting one that cannot start', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: KEYLESS, harnessId: 'claude', modes: ['cli'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_CREDENTIAL_REQUIRED');
    expect(res.body.error).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it('refuses a mode the harness has no support for', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: OLLAMA_ANTHROPIC, harnessId: 'claude', modes: ['api'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROVIDER_HARNESS_MODE_UNSUPPORTED');
  });

  it('refuses to add to a backend with an unresolved projection', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: BLOCKED, harnessId: 'claude', modes: ['cli'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_BINDING_BLOCKED');
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it('404s an unknown backend', async () => {
    const res = await request(app()).post('/api/providers/bindings')
      .send({ connectionId: '55555555-5555-4555-8555-555555555555', harnessId: 'claude', modes: ['cli'] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONNECTION_NOT_FOUND');
  });
});
