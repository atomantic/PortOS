/**
 * Shared-backend management, end to end (#6369): real Express route → real Zod
 * schema → the real `providerGraph` service → a doubled store and toolkit.
 *
 * Only the two persistence edges are doubled, because everything worth pinning
 * here happens between them:
 *
 *   - one edit to a shared backend reaches EVERY harness on it, in one
 *     projection, without renaming a route or moving a pin;
 *   - a stale revision is refused BEFORE anything is written;
 *   - a failed catalog refresh keeps the models the connection already knew,
 *     while a successful empty one is recorded as a real empty answer;
 *   - narrowing a binding's model subset touches no executable record at all;
 *   - no response ever carries a credential or a projection snapshot.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const store = {
  readGraph: vi.fn(),
  applyReconciliation: vi.fn().mockResolvedValue(undefined),
  commitPendingProjection: vi.fn().mockResolvedValue(undefined),
  acknowledgeProjection: vi.fn().mockResolvedValue(undefined),
  relinkBinding: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn(),
  detachBindingToConnection: vi.fn().mockResolvedValue(undefined),
  saveConnectionSettings: vi.fn().mockResolvedValue(2),
  saveBindingSettings: vi.fn().mockResolvedValue(2),
  saveRouteModelMap: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../services/providerGraphStore.js', () => store);

const providerService = {
  getAllProviders: vi.fn(),
  applyProviderPatches: vi.fn(),
  refreshProviderModelsBatch: vi.fn(),
};
// Partial: the routes module pulls the whole toolkit-state surface in through
// `services/providers.js`, so only `requireToolkit` is doubled.
vi.mock('../lib/aiToolkitState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requireToolkit: () => ({ services: { providers: providerService } }),
}));

const graph = await import('../services/providerGraph.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

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

function app() {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
}

beforeEach(async () => {
  vi.clearAllMocks();
  graph.resetProviderGraphState();
  store.readGraph.mockResolvedValue(graphFixture());
  store.saveConnectionSettings.mockResolvedValue(4);
  store.saveBindingSettings.mockResolvedValue(5);
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
  store.saveBindingSettings.mockResolvedValue(5);
  providerService.applyProviderPatches.mockImplementation(async (patches) => Object.keys(patches));
});

afterEach(() => vi.restoreAllMocks());

describe('PATCH /api/providers/connections/:id', () => {
  it('moves every harness on the backend with one edit, keeping route ids', async () => {
    const res = await request(app())
      .patch(`/api/providers/connections/${CONNECTION}`)
      .send({
        expectedRevision: 3,
        label: 'Renamed daemon',
        // The daemon moved port. Both protocol ports move with it, because
        // they are one backend, not two.
        transports: {
          anthropic: { baseUrl: 'http://127.0.0.1:22222' },
          openai: { baseUrl: 'http://127.0.0.1:22222/v1' },
        },
      });

    expect(res.status).toBe(200);
    // All three executable routes — both Claude modes AND OpenCode — follow the
    // one edit. That is the whole promise of a shared connection.
    expect(res.body.affectedRouteIds.sort())
      .toEqual(['claude-ollama', 'claude-ollama-tui', 'codex-ollama']);

    const [patches] = providerService.applyProviderPatches.mock.calls.at(-1);
    // Each harness follows the edit through ITS OWN protocol's env var — the
    // projection is per-transport, not one URL smeared over every route.
    expect(patches['claude-ollama'].envVars.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:22222');
    expect(patches['claude-ollama-tui'].envVars.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:22222');
    expect(patches['codex-ollama'].envVars.OPENAI_BASE_URL).toBe('http://127.0.0.1:22222/v1');
    // A route's OWN settings are never in the patch: an endpoint edit is not a
    // licence to rewrite a pin, a mode or an enabled flag.
    expect(patches['claude-ollama']).not.toHaveProperty('defaultModel');
    expect(patches['claude-ollama']).not.toHaveProperty('enabled');
  });

  it('stages the projection before writing the file and acknowledges only after', async () => {
    const order = [];
    store.commitPendingProjection.mockImplementation(async () => { order.push('stage'); });
    providerService.applyProviderPatches.mockImplementation(async (patches) => {
      order.push('write');
      return Object.keys(patches);
    });
    store.acknowledgeProjection.mockImplementation(async () => { order.push('ack'); });

    await request(app()).patch(`/api/providers/connections/${CONNECTION}`)
      .send({ expectedRevision: 3, label: 'Renamed daemon' });

    expect(order).toEqual(['stage', 'write', 'ack']);
  });

  it('refuses a stale revision without writing anything', async () => {
    const res = await request(app())
      .patch(`/api/providers/connections/${CONNECTION}`)
      .send({ expectedRevision: 2, label: 'Renamed from a screen that had moved on' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_STALE_REVISION');
    expect(store.saveConnectionSettings).not.toHaveBeenCalled();
    expect(providerService.applyProviderPatches).not.toHaveBeenCalled();
  });

  it('preserves an omitted credential and clears an explicitly null one', async () => {
    await request(app()).patch(`/api/providers/connections/${CONNECTION}`)
      .send({ expectedRevision: 3, label: 'Renamed daemon' });
    expect(store.saveConnectionSettings.mock.calls[0][0].credentials)
      .toEqual({ ANTHROPIC_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: OPENAI_KEY });

    // An explicit null clears exactly the one named key — the other harness's
    // secret on the same backend is not collateral.
    store.saveConnectionSettings.mockClear();
    await request(app()).patch(`/api/providers/connections/${CONNECTION}`)
      .send({ expectedRevision: 3, credentials: { ANTHROPIC_AUTH_TOKEN: null } });
    expect(store.saveConnectionSettings.mock.calls[0][0].credentials)
      .toEqual({ OPENAI_API_KEY: OPENAI_KEY });
  });

  it('refuses a credential echoed back as the redaction placeholder', async () => {
    const res = await request(app()).patch(`/api/providers/connections/${CONNECTION}`)
      .send({ expectedRevision: 3, credentials: { ANTHROPIC_AUTH_TOKEN: '***' } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROVIDER_GRAPH_REDACTED_CREDENTIAL');
    expect(store.saveConnectionSettings).not.toHaveBeenCalled();
  });

  it('refuses while a route on the backend is mid-projection', async () => {
    const fixture = graphFixture();
    fixture.routes[0].pending = ownedSnapshot();
    store.readGraph.mockResolvedValue(fixture);

    const res = await request(app()).patch(`/api/providers/connections/${CONNECTION}`)
      .send({ expectedRevision: 3, label: 'Renamed daemon' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_BINDING_BLOCKED');
    expect(store.saveConnectionSettings).not.toHaveBeenCalled();
  });

  it('rejects an unknown field rather than persisting it', async () => {
    const res = await request(app()).patch(`/api/providers/connections/${CONNECTION}`)
      .send({ expectedRevision: 3, kind: 'lmstudio' });

    expect(res.status).toBe(400);
    expect(store.saveConnectionSettings).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/connections/:id/refresh-models', () => {
  it('probes the shared backend once for every harness on it', async () => {
    providerService.refreshProviderModelsBatch.mockResolvedValue([
      { ids: ['claude-ollama', 'claude-ollama-tui', 'codex-ollama'], leadId: 'claude-ollama', status: 'updated' },
    ]);

    const res = await request(app()).post(`/api/providers/connections/${CONNECTION}/refresh-models`);

    expect(res.status).toBe(200);
    expect(providerService.refreshProviderModelsBatch).toHaveBeenCalledTimes(1);
    expect(providerService.refreshProviderModelsBatch.mock.calls[0][0].sort())
      .toEqual(['claude-ollama', 'claude-ollama-tui', 'codex-ollama']);
    expect(res.body.catalog.state).toBe('known');
    expect(res.body.catalog.models).toEqual(['example-model']);
  });

  it('keeps the models it already knew when the probe fails', async () => {
    providerService.refreshProviderModelsBatch.mockResolvedValue([
      { ids: ['claude-ollama'], leadId: 'claude-ollama', status: 'failed', error: new Error('connect ECONNREFUSED') },
    ]);

    const res = await request(app()).post(`/api/providers/connections/${CONNECTION}/refresh-models`);

    expect(res.status).toBe(200);
    expect(res.body.catalog.state).toBe('failed');
    // The catalog it had, not an empty backend — the failure mode this endpoint
    // exists to avoid.
    expect(res.body.catalog.models).toEqual(['example-model', 'retired-model']);
    expect(res.body.catalog.error).toContain('ECONNREFUSED');
  });

  it('strips the connection secret out of a failure message before storing it', async () => {
    providerService.refreshProviderModelsBatch.mockResolvedValue([
      {
        ids: ['claude-ollama'], leadId: 'claude-ollama', status: 'failed',
        error: new Error(`401 from ${DAEMON} using Authorization: Bearer ${TOKEN}`),
      },
    ]);

    const res = await request(app()).post(`/api/providers/connections/${CONNECTION}/refresh-models`);

    expect(res.body.catalog.error).not.toContain(TOKEN);
    expect(res.body.catalog.error).toContain('***');
  });

  it('records a successful empty answer as known-and-empty, not as never-asked', async () => {
    providerService.getAllProviders.mockResolvedValue({
      activeProvider: 'claude-ollama',
      providers: [
        { ...structuredClone(CLAUDE_CLI), models: [] },
        { ...structuredClone(CLAUDE_TUI), models: [] },
        { ...structuredClone(CODEX_CLI), models: [] },
      ],
    });
    providerService.refreshProviderModelsBatch.mockResolvedValue([
      { ids: ['claude-ollama'], leadId: 'claude-ollama', status: 'updated' },
    ]);

    const res = await request(app()).post(`/api/providers/connections/${CONNECTION}/refresh-models`);

    expect(res.body.catalog).toMatchObject({ state: 'known', models: [] });
  });

  it('never repicks a pin or the system default', async () => {
    providerService.refreshProviderModelsBatch.mockResolvedValue([
      { ids: ['claude-ollama'], leadId: 'claude-ollama', status: 'updated' },
    ]);

    await request(app()).post(`/api/providers/connections/${CONNECTION}/refresh-models`);

    // A refresh writes the catalog and the alias maps; it does not go near the
    // executable records' own model pins.
    expect(providerService.applyProviderPatches).not.toHaveBeenCalled();
  });

  it('refuses a connection with no executable route to probe', async () => {
    const res = await request(app()).post(`/api/providers/connections/${OTHER_CONNECTION}/refresh-models`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_CONNECTION_UNROUTED');
    expect(providerService.refreshProviderModelsBatch).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/providers/bindings/:id', () => {
  it('narrows one harness to a subset without touching any executable record', async () => {
    const res = await request(app())
      .patch(`/api/providers/bindings/${CLAUDE_BINDING}`)
      .send({ expectedRevision: 4, selectedModels: ['example-model'] });

    expect(res.status).toBe(200);
    expect(res.body.selectedModels).toEqual(['example-model']);
    // Management state only: no projection, so no route's enabled flag, consent
    // or model pin can move as a side effect of a menu choice.
    expect(providerService.applyProviderPatches).not.toHaveBeenCalled();
    expect(store.commitPendingProjection).not.toHaveBeenCalled();
  });

  it('refuses a stale revision without writing', async () => {
    const res = await request(app())
      .patch(`/api/providers/bindings/${CLAUDE_BINDING}`)
      .send({ expectedRevision: 3, selectedModels: [] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROVIDER_GRAPH_STALE_REVISION');
    expect(store.saveBindingSettings).not.toHaveBeenCalled();
  });

  it('rejects an `enabled` field, so a menu edit can never grant execution', async () => {
    const res = await request(app())
      .patch(`/api/providers/bindings/${CLAUDE_BINDING}`)
      .send({ expectedRevision: 4, enabled: true });

    expect(res.status).toBe(400);
    expect(store.saveBindingSettings).not.toHaveBeenCalled();
  });

  it('404s an unknown binding rather than creating one', async () => {
    const res = await request(app())
      .patch('/api/providers/bindings/55555555-5555-4555-8555-555555555555')
      .send({ expectedRevision: 1, label: 'Invented' });

    expect(res.status).toBe(404);
    expect(store.saveBindingSettings).not.toHaveBeenCalled();
  });
});

describe('the management graph a browser actually receives', () => {
  it('reports credential PRESENCE and never a secret or a projection snapshot', async () => {
    const res = await request(app()).get('/api/providers/management');
    const body = JSON.stringify(res.body);

    expect(res.status).toBe(200);
    expect(res.body.connections[0].hasCredentials).toBe(true);
    expect(body).not.toContain(TOKEN);
    expect(res.body.connections[0]).not.toHaveProperty('credentials');
    expect(res.body.routes[0]).not.toHaveProperty('projected');
    expect(res.body.routes[0]).not.toHaveProperty('pending');
  });
});

describe('a partially reachable backend', () => {
  it('reports the models it did observe AND the harness that could not reach it', async () => {
    providerService.refreshProviderModelsBatch.mockResolvedValue([
      { ids: ['claude-ollama', 'claude-ollama-tui'], leadId: 'claude-ollama', status: 'updated' },
      { ids: ['codex-ollama'], leadId: 'codex-ollama', status: 'failed', error: new Error('404 from the /v1 port') },
    ]);

    const res = await request(app()).post(`/api/providers/connections/${CONNECTION}/refresh-models`);

    // `known`, because the listed models really were observed…
    expect(res.body.catalog.state).toBe('known');
    // …but the failure is not swallowed by the group that worked.
    expect(res.body.catalog.error).toContain('/v1 port');
    expect(res.body.failedGroups).toBe(1);
  });
});
