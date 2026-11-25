/**
 * The provider-graph orchestration contract (#6367): projection ordering,
 * re-entrancy, and the revision gate on link/unlink.
 *
 * The reconciliation POLICY is pinned purely in
 * `server/lib/provider/providerGraphRecords.test.js` and the row constraints in
 * `providerGraphStore.db.test.js`. What is only observable HERE is sequencing:
 * that a projection stages before it writes and acknowledges only after, that a
 * projection's own provider-file write cannot recurse back into a reconcile
 * pass, and that a link refuses stale or blocked state before it touches a row.
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
vi.mock('./providerGraphStore.js', () => store);

const providers = {
  getAllProviders: vi.fn(),
  applyProviderPatches: vi.fn(),
};
vi.mock('../../lib/aiToolkitState.js', () => ({
  requireToolkit: () => ({ services: { providers } }),
}));

// `updateConnectionSettings` re-derives every DERIVED preset on the row it
// just saved, which reads the bootstrap-apps table — kept doubled and empty
// so this file never reaches `settings.js`'s real file store.
vi.mock('../credentialBootstrapApps.js', () => ({ listCredentialBootstraps: vi.fn().mockResolvedValue({}) }));

const graph = await import('./providerGraph.js');

const CONN_A = '11111111-1111-4111-8111-111111111111';
const CONN_B = '22222222-2222-4222-8222-222222222222';
const BINDING = '33333333-3333-4333-8333-333333333333';

const connection = (id, baseUrl, slug) => ({
  id,
  revision: 1,
  kind: 'ollama',
  label: 'Example daemon',
  transports: { anthropic: { baseUrl } },
  credentials: { ANTHROPIC_AUTH_TOKEN: `token-for-${id}` },
  catalog: { state: 'known', models: ['example-model'] },
  // Named service instances (#7563), so the record below can be a derived
  // preset (#7565) declaring the one it sits on.
  slug, definitionId: 'ollama', plan: 'local', enabled: true, credentialVia: 'stored',
});

const CLAUDE = {
  id: 'claude-ollama',
  name: 'Claude',
  type: 'cli',
  command: 'claude',
  // Makes the record's connection kind 'ollama', matching the fixture rows.
  ollamaBacked: true,
  enabled: true,
  models: ['example-model'],
  // Matches connection CONN_A exactly, so the baseline is a settled graph.
  envVars: { ANTHROPIC_BASE_URL: `http://127.0.0.1:11434`, ANTHROPIC_AUTH_TOKEN: `token-for-${CONN_A}` },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  // Already a derived preset on CONN_A, so a settled pass has nothing to stamp.
  harnessId: 'claude', method: 'cli', serviceId: 'ollama',
};

const graphFixture = () => ({
  connections: [connection(CONN_A, 'http://127.0.0.1:11434', 'ollama'), connection(CONN_B, 'http://127.0.0.1:12345', 'ollama-2')],
  bindings: [{
    id: BINDING, revision: 1, connectionId: CONN_A, harnessId: 'claude',
    variantKey: 'default', label: 'Claude', enabled: true, selectedModels: ['example-model'],
  }],
  routes: [{
    providerId: 'claude-ollama', bindingId: BINDING, mode: 'cli',
    modelMap: { 'example-model': 'example-model' },
    projected: { fields: {}, envVars: { ...CLAUDE.envVars }, hasEnvVars: true },
    pending: null, pendingRevision: null,
  }],
});

beforeEach(async () => {
  vi.clearAllMocks();
  graph.resetProviderGraphState();
  store.readGraph.mockResolvedValue(graphFixture());
  providers.getAllProviders.mockResolvedValue({
    activeProvider: 'claude-ollama',
    providers: [structuredClone(CLAUDE)],
  });
  providers.applyProviderPatches.mockImplementation(async (patches) => Object.keys(patches));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('before the database phase enables the graph', () => {
  it('a legacy provider save does nothing at all', async () => {
    expect(await graph.onProvidersSaved()).toBeNull();
    expect(store.readGraph).not.toHaveBeenCalled();
  });
});

describe('reconciliation', () => {
  it('is a no-op pass when the file and the graph already agree', async () => {
    await graph.initProviderGraph();
    expect(store.applyReconciliation).not.toHaveBeenCalled();
    expect(providers.applyProviderPatches).not.toHaveBeenCalled();
  });

  // #7565: the preset backfill rides the pass. A routed legacy record whose
  // re-derivation is a fixpoint is stamped with ONLY the structural keys; the
  // stamped record is skipped on the next pass.
  it('stamps a routed legacy record as a derived preset, additively, once', async () => {
    const { harnessId, method, serviceId, ...legacy } = structuredClone(CLAUDE);
    providers.getAllProviders.mockResolvedValue({ activeProvider: 'claude-ollama', providers: [legacy] });

    await graph.initProviderGraph();
    expect(providers.applyProviderPatches).toHaveBeenCalledTimes(1);
    expect(providers.applyProviderPatches).toHaveBeenCalledWith({ 'claude-ollama': { harnessId, method, serviceId } });
    // Its own write fires the save hook; the latch keeps that from re-entering.
    expect(store.readGraph).toHaveBeenCalledTimes(1);

    providers.getAllProviders.mockResolvedValue({ activeProvider: 'claude-ollama', providers: [structuredClone(CLAUDE)] });
    providers.applyProviderPatches.mockClear();
    await graph.onProvidersSaved();
    expect(providers.applyProviderPatches).not.toHaveBeenCalled();
  });

  it('leaves a routed record legacy when re-deriving it would change how it runs', async () => {
    // A path-configured binary is a deliberate choice materialization would overwrite.
    const { harnessId, method, serviceId, ...legacy } = structuredClone(CLAUDE);
    providers.getAllProviders.mockResolvedValue({ activeProvider: 'claude-ollama', providers: [{ ...legacy, command: '/opt/bin/claude' }] });
    await graph.initProviderGraph();
    expect(providers.applyProviderPatches).not.toHaveBeenCalled();
  });

  it('retries an interrupted projection, then acknowledges it in the same plan', async () => {
    const fixture = graphFixture();
    fixture.routes[0].pending = {
      fields: {},
      envVars: { ...CLAUDE.envVars, ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345' },
      hasEnvVars: true,
    };
    store.readGraph.mockResolvedValue(fixture);

    await graph.initProviderGraph();

    expect(providers.applyProviderPatches).toHaveBeenCalledWith({
      'claude-ollama': { envVars: { ...CLAUDE.envVars, ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345' } },
    });
    // Acknowledged only because the retry write succeeded.
    expect(store.applyReconciliation.mock.calls[0][0].acknowledgements)
      .toEqual([{ providerId: 'claude-ollama' }]);
  });

  it('does not recurse when its own retry write fires the legacy save hook', async () => {
    // The retry goes through the toolkit, which calls onProvidersSaved — the
    // latch is the only thing between that and an infinite reconcile loop.
    const fixture = graphFixture();
    fixture.routes[0].pending = { fields: {}, envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345' }, hasEnvVars: true };
    store.readGraph.mockResolvedValue(fixture);
    providers.applyProviderPatches.mockImplementation(async (patches) => {
      await graph.onProvidersSaved();
      return Object.keys(patches);
    });

    await graph.initProviderGraph();
    expect(store.readGraph).toHaveBeenCalledTimes(1);
  });

  it('leaves an externally changed route untouched and logs it', async () => {
    const fixture = graphFixture();
    fixture.routes[0].pending = { fields: {}, envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345' }, hasEnvVars: true };
    store.readGraph.mockResolvedValue(fixture);
    providers.getAllProviders.mockResolvedValue({
      activeProvider: 'claude-ollama',
      // A third value: neither the projected snapshot nor the pending one.
      providers: [{ ...structuredClone(CLAUDE), envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:7777' } }],
    });

    await graph.initProviderGraph();
    expect(providers.applyProviderPatches).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('changed outside the graph'));
  });

  it('a legacy save runs one pass once the graph is enabled', async () => {
    await graph.initProviderGraph();
    store.readGraph.mockClear();
    await graph.onProvidersSaved();
    expect(store.readGraph).toHaveBeenCalledTimes(1);
  });
});

describe('connection settings keep the preset-conversion cache live (#8159)', () => {
  it('updates presetSkipReason for this connection\'s legacy routes on the SAME write, not the next reconcile pass', async () => {
    // The connection's base URL does not yet match the routed legacy
    // record's own ANTHROPIC_BASE_URL, so the boot pass leaves it legacy —
    // re-deriving it would rewrite the env var it already carries.
    const fixture = graphFixture();
    fixture.connections[0] = connection(CONN_A, 'http://127.0.0.1:19999', 'ollama');
    store.readGraph.mockResolvedValue(fixture);
    const { harnessId, method, serviceId, ...legacy } = structuredClone(CLAUDE);
    providers.getAllProviders.mockResolvedValue({ activeProvider: 'claude-ollama', providers: [legacy] });

    await graph.initProviderGraph();
    expect(graph.presetSkipReason('claude-ollama')).toMatch(/^drift:/);

    // Fixing the connection's own base URL makes re-deriving the record a
    // fixpoint. A connection-settings edit never writes `providers.json`, so
    // `onProvidersSaved` never fires and no reconcile pass runs — the cache
    // must still answer correctly right after THIS write.
    await graph.updateConnectionSettings({
      connectionId: CONN_A, expectedRevision: 1, transports: { anthropic: { baseUrl: 'http://127.0.0.1:11434' } },
    });
    expect(graph.presetSkipReason('claude-ollama')).toBeNull();

    // And the reverse: moving the connection back off the record's own
    // ANTHROPIC_BASE_URL makes it drift again, live, the same way.
    await graph.updateConnectionSettings({
      connectionId: CONN_A, expectedRevision: 1, transports: { anthropic: { baseUrl: 'http://127.0.0.1:19999' } },
    });
    expect(graph.presetSkipReason('claude-ollama')).toMatch(/^drift:/);
  });

  it('leaves an unrelated connection\'s cached verdict untouched', async () => {
    await graph.initProviderGraph();
    expect(graph.presetSkipReason('claude-ollama')).toBeNull();
    // CONN_B carries no routes in the fixture, so this is a no-op scan, not a
    // crash on an empty route list.
    await expect(graph.updateConnectionSettings({
      connectionId: CONN_B, expectedRevision: 1, label: 'Renamed',
    })).resolves.toMatchObject({ connectionId: CONN_B });
    expect(graph.presetSkipReason('claude-ollama')).toBeNull();
  });
});

describe('deleting an emptied connection', () => {
  beforeEach(() => graph.initProviderGraph());

  it('removes a connection nothing binds', async () => {
    store.deleteConnection.mockResolvedValue({ deleted: true });
    expect(await graph.removeConnection(CONN_B)).toEqual({ deleted: true });
  });

  it('refuses while a binding still names it, rather than orphaning the binding', async () => {
    store.deleteConnection.mockResolvedValue({ deleted: false, reason: 'referenced-by-binding' });
    await expect(graph.removeConnection(CONN_A))
      .rejects.toMatchObject({ status: 409, code: 'PROVIDER_GRAPH_CONNECTION_IN_USE' });
  });
});

describe('service-instance naming (#7563)', () => {
  it('names a boot-imported fragment before it is written, and backfills unnamed rows after', async () => {
    const fixture = graphFixture();
    // CONN_A predates the columns; CONN_B is already named.
    for (const key of ['slug', 'definitionId', 'plan', 'enabled', 'credentialVia']) delete fixture.connections[0][key];
    fixture.connections[1].slug = 'ollama';
    store.readGraph.mockResolvedValue(fixture);
    // The second record is a LEGACY one the graph has never routed: it declares
    // no service, so it imports as its own fragment rather than onto a row.
    const { harnessId, method, serviceId, ...legacy } = structuredClone(CLAUDE);
    providers.getAllProviders.mockResolvedValue({
      activeProvider: 'claude-ollama',
      providers: [structuredClone(CLAUDE), { ...legacy, id: 'claude-other', envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555', ANTHROPIC_AUTH_TOKEN: 'other' } }],
    });
    await graph.initProviderGraph();
    const [plan] = store.applyReconciliation.mock.calls[0];
    expect(plan.imports.connections[0]).toMatchObject({ kind: 'ollama', slug: 'ollama-2', definitionId: 'ollama', plan: 'local' });
    expect(store.applyServiceColumnBackfill).toHaveBeenCalledWith([{ id: CONN_A, slug: 'ollama-3', definitionId: 'ollama', plan: 'local' }]);
  });
});
