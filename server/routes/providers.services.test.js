/**
 * Service instances end to end (#7563): real Express route → real Zod schema →
 * the real `providerServices` / `providerGraph` services → a doubled store,
 * toolkit, models probe and harness lister.
 *
 * What only this boundary can pin:
 *
 *   - two instances of ONE definition under different plans refresh to
 *     different catalogs from one probe answer, and the plan is what decides;
 *   - a failed refresh keeps the previous catalog; a harness whose binary is
 *     missing reports `failed`, never an empty list; an empty success is `[]`;
 *   - a `bootstrap` instance stores nothing whatever was sent;
 *   - no response carries a credential value, and the redaction placeholder is
 *     refused when echoed back;
 *   - a slug and a UUID address the same row on both surfaces.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { REDACTED_CREDENTIAL } from '../lib/providerConnections.js';

const store = {
  readGraph: vi.fn(),
  writeGraph: vi.fn().mockResolvedValue({ connections: 1, bindings: 0, routes: 0 }),
  applyReconciliation: vi.fn().mockResolvedValue(undefined),
  applyServiceColumnBackfill: vi.fn().mockResolvedValue(undefined),
  commitPendingProjection: vi.fn().mockResolvedValue(undefined),
  acknowledgeProjection: vi.fn().mockResolvedValue(undefined),
  relinkBinding: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn(),
  detachBindingToConnection: vi.fn().mockResolvedValue(undefined),
  mergeServiceInstances: vi.fn().mockResolvedValue(undefined),
  saveConnectionSettings: vi.fn().mockResolvedValue(2),
  saveBindingSettings: vi.fn().mockResolvedValue(2),
  saveRouteModelMap: vi.fn().mockResolvedValue(undefined),
  saveRouteModelAliases: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../services/providerGraphStore.js', () => store);

const providerService = {
  getAllProviders: vi.fn(),
  applyProviderPatches: vi.fn(),
  refreshProviderModelsBatch: vi.fn(),
  fetchProviderModels: vi.fn(),
  getProviderById: vi.fn(),
  refreshProviderModels: vi.fn(),
};
vi.mock('../lib/aiToolkitState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requireToolkit: () => ({ services: { providers: providerService } }),
}));

const probe = vi.fn();
vi.mock('../lib/openAiModelsProbe.js', () => ({ probeOpenAiModels: probe }));

const harnessModels = vi.fn();
vi.mock('../services/harnesses.js', () => ({ refreshHarnessModels: harnessModels, harnessCatalogRuntime: vi.fn(() => null) }));

vi.mock('../services/credentialInventory.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadInstallEnvFile: async () => new Map([['CEREBRAS_API_KEY', 'example-env-file-key']]),
}));

const graph = await import('../services/providerGraph.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

const ZEN_FREE = '11111111-1111-4111-8111-111111111111';
const ZEN_PAID = '22222222-2222-4222-8222-222222222222';
const NIM_FREE = '33333333-3333-4333-8333-333333333333';
const NIM_PAID = '44444444-4444-4444-8444-444444444444';
const CLAUDE_SUB = '55555555-5555-4555-8555-555555555555';
const BOOTSTRAP = '66666666-6666-4666-8666-666666666666';
const LEGACY = '77777777-7777-4777-8777-777777777777';
const BINDING = '88888888-8888-4888-8888-888888888888';
const ZEN_KEY = 'example-zen-secret';

const instance = (overrides) => ({
  revision: 1,
  label: 'Example',
  credentials: {},
  catalog: { state: 'unknown', models: [] },
  enabled: true,
  credentialVia: 'stored',
  ...overrides,
});

const graphFixture = () => ({
  connections: [
    instance({
      id: ZEN_FREE, kind: 'vendor', slug: 'opencode-zen', definitionId: 'opencode-zen', plan: 'free',
      transports: { openai: { baseUrl: 'https://opencode.ai/zen/v1' } }, credentials: { apiKey: ZEN_KEY },
      catalog: { state: 'known', models: ['old-free'] },
    }),
    instance({
      id: ZEN_PAID, kind: 'vendor', slug: 'opencode-zen-2', definitionId: 'opencode-zen', plan: 'paid',
      transports: { openai: { baseUrl: 'https://opencode.ai/zen/v1' } }, credentials: { apiKey: ZEN_KEY },
    }),
    instance({
      id: NIM_FREE, kind: 'gateway:nvidia-nim', slug: 'nvidia-nim', definitionId: 'nvidia-nim', plan: 'free',
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } }, credentials: { apiKey: 'example-nim-key' },
    }),
    instance({
      id: NIM_PAID, kind: 'gateway:nvidia-nim', slug: 'nvidia-nim-2', definitionId: 'nvidia-nim', plan: 'paid',
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } }, credentials: { apiKey: 'example-nim-key' },
    }),
    instance({
      id: CLAUDE_SUB, kind: 'vendor', slug: 'claude-subscription', definitionId: 'claude-subscription', plan: 'subscription',
      transports: {}, credentialVia: 'cli-login', catalog: { state: 'known', models: ['claude-example'] },
    }),
    instance({
      id: BOOTSTRAP, kind: 'api', slug: 'openai', definitionId: 'openai', plan: 'paid',
      transports: { openai: { baseUrl: 'https://api.openai.com/v1' } }, credentialVia: 'bootstrap',
    }),
    // A row from before the columns existed: no slug, no definition.
    instance({ id: LEGACY, kind: 'api', slug: null, definitionId: null, plan: 'paid', transports: { openai: { baseUrl: 'http://127.0.0.1:9999/v1' } } }),
  ],
  bindings: [{
    id: BINDING, revision: 1, connectionId: NIM_PAID, harnessId: 'opencode',
    variantKey: 'default', label: 'OpenCode', enabled: false, selectedModels: [],
  }],
  routes: [],
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
  store.saveConnectionSettings.mockResolvedValue(2);
  providerService.getAllProviders.mockResolvedValue({ activeProvider: null, providers: [] });
  providerService.applyProviderPatches.mockImplementation(async (patches) => Object.keys(patches));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await graph.initProviderGraph();
  vi.clearAllMocks();
  store.readGraph.mockResolvedValue(graphFixture());
  store.saveConnectionSettings.mockResolvedValue(2);
});

afterEach(() => vi.restoreAllMocks());

describe('GET /api/providers/services', () => {
  it('lists every instance with presence and source, and never a credential value', async () => {
    const res = await request(app()).get('/api/providers/services');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(ZEN_KEY);
    expect(res.text).not.toContain('example-nim-key');
    const bySlug = Object.fromEntries(res.body.services.map((service) => [service.slug, service]));
    expect(bySlug['opencode-zen']).toMatchObject({ plan: 'free', hasCredentials: true, credentialVia: 'stored', credentialSource: 'settings', readiness: 'ready' });
    expect(bySlug['claude-subscription']).toMatchObject({ hasCredentials: false, credentialVia: 'cli-login', credentialSource: 'cli', readiness: 'ready' });
    expect(bySlug.openai).toMatchObject({ hasCredentials: false, credentialVia: 'bootstrap', credentialSource: 'config', enabled: true });
    expect(bySlug['nvidia-nim-2'].bindingCount).toBe(1);
    // The unnamed legacy row is still listed, honestly: no definition yet.
    expect(res.body.services.find((service) => service.id === LEGACY)).toMatchObject({ slug: null, definition: null, readiness: 'unknown-definition' });
  });

  it('names the boot backfill for a row that predates the columns, without a provider call', async () => {
    graph.resetProviderGraphState();
    store.readGraph.mockResolvedValue(graphFixture());
    await graph.initProviderGraph();
    expect(store.applyServiceColumnBackfill).toHaveBeenCalledWith([
      { id: LEGACY, slug: 'openai-compatible', definitionId: 'openai-compatible', plan: 'free' },
    ]);
    expect(probe).not.toHaveBeenCalled();
    expect(harnessModels).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/services', () => {
  it('creates an instance from a definition with the next free slug, the first plan, and no probe', async () => {
    const res = await request(app()).post('/api/providers/services')
      .send({ definitionId: 'nvidia-nim', credentials: { apiKey: 'example-new-key' } });
    expect(res.status).toBe(201);
    const [written] = store.writeGraph.mock.calls.at(-1);
    expect(written.connections[0]).toMatchObject({
      kind: 'gateway:nvidia-nim', slug: 'nvidia-nim-3', definitionId: 'nvidia-nim', plan: 'free', enabled: true,
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } }, credentials: { apiKey: 'example-new-key' },
      catalog: { state: 'unknown', models: [] },
    });
    expect(res.body.service).toMatchObject({ slug: 'nvidia-nim-3', plan: 'free', hasCredentials: true, readiness: 'ready' });
    expect(res.text).not.toContain('example-new-key');
    expect(probe).not.toHaveBeenCalled();
  });

  it('stores no secret for a bootstrap instance, reports it keyless and enabled', async () => {
    const res = await request(app()).post('/api/providers/services')
      .send({ definitionId: 'anthropic', slug: 'anthropic-wrapped', credentialVia: 'bootstrap', credentials: { apiKey: 'must-not-land' } });
    expect(res.status).toBe(201);
    const [written] = store.writeGraph.mock.calls.at(-1);
    expect(written.connections[0]).toMatchObject({ credentials: {}, credentialVia: 'bootstrap', enabled: true, kind: 'api' });
    expect(res.body.service).toMatchObject({ hasCredentials: false, credentialVia: 'bootstrap', enabled: true, slug: 'anthropic-wrapped' });
  });

  it('refuses a plan the definition does not sell, a taken slug and an unknown definition', async () => {
    expect((await request(app()).post('/api/providers/services').send({ definitionId: 'anthropic', plan: 'free' })).status).toBe(400);
    const taken = await request(app()).post('/api/providers/services').send({ definitionId: 'nvidia-nim', slug: 'nvidia-nim' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SERVICE_SLUG_TAKEN');
    expect((await request(app()).post('/api/providers/services').send({ definitionId: 'no-such-service' })).status).toBe(400);
    expect((await request(app()).post('/api/providers/services').send({ definitionId: 'nvidia-nim', slug: 'Not Valid' })).status).toBe(400);
    expect(store.writeGraph).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/providers/services/:slug', () => {
  it('changes the plan and enablement on the row, addressed by slug', async () => {
    const res = await request(app()).patch('/api/providers/services/nvidia-nim')
      .send({ expectedRevision: 1, plan: 'paid', enabled: false });
    expect(res.status).toBe(200);
    expect(store.saveConnectionSettings).toHaveBeenCalledWith(expect.objectContaining({
      id: NIM_FREE, plan: 'paid', enabled: false, credentials: { apiKey: 'example-nim-key' },
    }));
  });

  it('refuses a stale revision, an unsupported plan and an echoed redaction placeholder', async () => {
    expect((await request(app()).patch('/api/providers/services/nvidia-nim').send({ expectedRevision: 9, plan: 'paid' })).status).toBe(409);
    expect((await request(app()).patch(`/api/providers/services/${BOOTSTRAP}`).send({ expectedRevision: 1, plan: 'free' })).status).toBe(400);
    const echoed = await request(app()).patch('/api/providers/services/opencode-zen')
      .send({ expectedRevision: 1, credentials: { apiKey: REDACTED_CREDENTIAL } });
    expect(echoed.status).toBe(400);
    expect(echoed.body.code).toBe('PROVIDER_GRAPH_REDACTED_CREDENTIAL');
    expect(store.saveConnectionSettings).not.toHaveBeenCalled();
  });

  it('drops the stored secret when an instance switches to bootstrap', async () => {
    await request(app()).patch('/api/providers/services/opencode-zen').send({ expectedRevision: 1, credentialVia: 'bootstrap' });
    expect(store.saveConnectionSettings).toHaveBeenCalledWith(expect.objectContaining({ id: ZEN_FREE, credentials: {}, credentialVia: 'bootstrap' }));
  });
});

describe('DELETE /api/providers/services/:slug', () => {
  it('refuses while a binding still names the row, and deletes an unbound one by slug', async () => {
    store.deleteConnection.mockResolvedValueOnce({ deleted: false, reason: 'referenced-by-binding' });
    expect((await request(app()).delete('/api/providers/services/nvidia-nim-2')).status).toBe(409);
    store.deleteConnection.mockResolvedValueOnce({ deleted: true });
    expect((await request(app()).delete('/api/providers/services/nvidia-nim')).status).toBe(200);
    expect(store.deleteConnection).toHaveBeenLastCalledWith(NIM_FREE);
    expect((await request(app()).delete('/api/providers/services/nobody')).status).toBe(404);
  });
});

describe('POST /api/providers/services/:slug/refresh-catalog', () => {
  const listing = ['big-pickle', 'example-paid-model', 'mimo-v2.5-free', 'deepseek-v4-flash-free'];

  it('gives two plans of one definition different catalogs from one probe answer', async () => {
    probe.mockResolvedValue({ reachable: true, models: listing, contextWindows: { 'big-pickle': 128000 }, error: null });
    const free = await request(app()).post('/api/providers/services/opencode-zen/refresh-catalog');
    const paid = await request(app()).post(`/api/providers/services/${ZEN_PAID}/refresh-catalog`);
    expect(free.status).toBe(200);
    expect(free.body.service.catalog).toMatchObject({ state: 'known', models: ['big-pickle', 'mimo-v2.5-free', 'deepseek-v4-flash-free'], error: null });
    expect(paid.body.service.catalog).toMatchObject({ state: 'known', models: listing, capabilities: { 'big-pickle': { contextWindow: 128000 } } });
    // Its OWN endpoint with its OWN key — never a route's.
    expect(probe).toHaveBeenCalledWith('https://opencode.ai/zen/v1', expect.objectContaining({ apiKey: ZEN_KEY }));
    expect(free.text).not.toContain(ZEN_KEY);
    expect(providerService.refreshProviderModelsBatch).not.toHaveBeenCalled();
  });

  it('lists the whole answer for both NIM plans, where no tier marker exists', async () => {
    probe.mockResolvedValue({ reachable: true, models: listing, contextWindows: {}, error: null });
    const free = await request(app()).post('/api/providers/services/nvidia-nim/refresh-catalog');
    const paid = await request(app()).post('/api/providers/services/nvidia-nim-2/refresh-catalog');
    expect(free.body.service.catalog.models).toEqual(listing);
    expect(paid.body.service.catalog.models).toEqual(listing);
    expect(free.body.service.plan).toBe('free');
    expect(paid.body.service.plan).toBe('paid');
  });

  it('keeps the previous catalog on a failure, with the secret stripped from the reason', async () => {
    probe.mockResolvedValue({ reachable: true, models: null, contextWindows: null, error: `authentication required for ${ZEN_KEY}` });
    const res = await request(app()).post('/api/providers/services/opencode-zen/refresh-catalog');
    expect(res.status).toBe(200);
    expect(res.body.service.catalog).toMatchObject({ state: 'failed', models: ['old-free'] });
    expect(res.body.service.catalog.error).toContain(REDACTED_CREDENTIAL);
    expect(res.body.service.catalog.error).not.toContain(ZEN_KEY);
    expect(store.saveConnectionSettings.mock.calls[0][0].catalog.error).not.toContain(ZEN_KEY);
  });

  it('records a successful empty answer as known-and-empty', async () => {
    probe.mockResolvedValue({ reachable: true, models: [], contextWindows: {}, error: null });
    const res = await request(app()).post('/api/providers/services/opencode-zen/refresh-catalog');
    expect(res.body.service.catalog).toMatchObject({ state: 'known', models: [], error: null });
  });

  it('asks the signing-in program for a harness catalog, and reports a missing binary as failed, never []', async () => {
    harnessModels.mockResolvedValue({ ok: false, reason: 'Claude Code is not installed on this host.', models: [], updated: [] });
    const res = await request(app()).post('/api/providers/services/claude-subscription/refresh-catalog');
    expect(harnessModels).toHaveBeenCalledWith('claude');
    expect(res.body.service.catalog).toMatchObject({ state: 'failed', models: ['claude-example'], error: 'Claude Code is not installed on this host.' });
    expect(probe).not.toHaveBeenCalled();

    harnessModels.mockResolvedValue({ ok: true, models: ['claude-a', 'claude-b'], updated: [] });
    const ok = await request(app()).post('/api/providers/services/claude-subscription/refresh-catalog');
    expect(ok.body.service.catalog).toMatchObject({ state: 'known', models: ['claude-a', 'claude-b'] });
  });

  // Codex's row now has its own lister (`listModels`, driving `codex
  // app-server` — services/harnesses.js #8497), so `listByHarness` no longer
  // falls back to a bound route's toolkit lister for a harness that refuses
  // with `noLister`. A harness with no lister at all just fails, as any other
  // refusal does.
  it('does not fall back to a bound route\'s own lister when the harness has no models command', async () => {
    const withRoute = graphFixture();
    withRoute.bindings.push({ id: '99999999-9999-4999-8999-999999999999', revision: 1, connectionId: CLAUDE_SUB, harnessId: 'claude', variantKey: 'default', label: 'Claude', enabled: true, selectedModels: [] });
    withRoute.routes.push({ providerId: 'example-claude-tui', bindingId: '99999999-9999-4999-8999-999999999999' });
    store.readGraph.mockResolvedValue(withRoute);
    harnessModels.mockResolvedValue({ ok: false, reason: 'Claude Code has no command for listing its models.', noLister: true, models: [], updated: [] });

    const res = await request(app()).post('/api/providers/services/claude-subscription/refresh-catalog');
    expect(providerService.fetchProviderModels).not.toHaveBeenCalled();
    expect(res.body.service.catalog).toMatchObject({
      state: 'failed', models: ['claude-example'], error: 'Claude Code has no command for listing its models.',
    });
  });

  it('refreshes a derived preset through its service catalog, never onto the record alone', async () => {
    const preset = { id: 'example-claude-tui', name: 'Claude', type: 'tui', command: 'claude', models: ['claude-example'], harnessId: 'claude', method: 'tui', serviceId: 'claude-subscription' };
    providerService.getProviderById.mockResolvedValue(preset);
    harnessModels.mockResolvedValue({ ok: true, models: ['claude-a', 'claude-b'], updated: [] });
    const res = await request(app()).post('/api/providers/example-claude-tui/refresh-models');
    expect(res.status).toBe(200);
    expect(providerService.refreshProviderModels).not.toHaveBeenCalled();
    expect(store.saveConnectionSettings).toHaveBeenCalledWith(expect.objectContaining({ id: CLAUDE_SUB, catalog: expect.objectContaining({ state: 'known', models: ['claude-a', 'claude-b'] }) }));

    harnessModels.mockResolvedValue({ ok: false, reason: 'Claude Code is not installed on this host.', models: [], updated: [] });
    const failed = await request(app()).post('/api/providers/example-claude-tui/refresh-models');
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain('not installed');
  });

  it('refuses a row with no definition to list through, and 404s an unknown slug', async () => {
    const res = await request(app()).post(`/api/providers/services/${LEGACY}/refresh-catalog`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVICE_DEFINITION_UNKNOWN');
    expect((await request(app()).post('/api/providers/services/nobody/refresh-catalog')).status).toBe(404);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('slug and UUID address one row on both surfaces', () => {
  it('lets the older connection routes take a slug', async () => {
    const res = await request(app()).patch('/api/providers/connections/nvidia-nim')
      .send({ expectedRevision: 1, label: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.connectionId).toBe(NIM_FREE);
    expect(store.saveConnectionSettings).toHaveBeenCalledWith(expect.objectContaining({ id: NIM_FREE, label: 'Renamed' }));
  });

  it('publishes the instance columns on the management graph too', async () => {
    const res = await request(app()).get('/api/providers/management');
    const zen = res.body.connections.find((connection) => connection.id === ZEN_FREE);
    expect(zen).toMatchObject({ slug: 'opencode-zen', definitionId: 'opencode-zen', plan: 'free', enabled: true, credentialVia: 'stored', hasCredentials: true });
    expect(res.body.connections.find((connection) => connection.id === BOOTSTRAP).hasCredentials).toBe(false);
  });
});
