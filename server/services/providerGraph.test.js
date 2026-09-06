/**
 * The provider-graph orchestration contract (#6367): projection ordering,
 * re-entrancy, and the revision gate on link/unlink.
 *
 * The reconciliation POLICY is pinned purely in
 * `server/lib/providerGraphRecords.test.js` and the row constraints in
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
  applyReconciliation: vi.fn().mockResolvedValue(undefined),
  commitPendingProjection: vi.fn().mockResolvedValue(undefined),
  acknowledgeProjection: vi.fn().mockResolvedValue(undefined),
  relinkBinding: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn(),
  detachBindingToConnection: vi.fn().mockResolvedValue(undefined),
};
vi.mock('./providerGraphStore.js', () => store);

const providers = {
  getAllProviders: vi.fn(),
  applyProviderPatches: vi.fn(),
};
vi.mock('../lib/aiToolkitState.js', () => ({
  requireToolkit: () => ({ services: { providers } }),
}));

const graph = await import('./providerGraph.js');

const CONN_A = '11111111-1111-4111-8111-111111111111';
const CONN_B = '22222222-2222-4222-8222-222222222222';
const BINDING = '33333333-3333-4333-8333-333333333333';

const connection = (id, baseUrl) => ({
  id,
  revision: 1,
  kind: 'ollama',
  label: 'Example daemon',
  transports: { anthropic: { baseUrl } },
  credentials: { ANTHROPIC_AUTH_TOKEN: `token-for-${id}` },
  catalog: { state: 'known', models: ['example-model'] },
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
};

const graphFixture = () => ({
  connections: [connection(CONN_A, 'http://127.0.0.1:11434'), connection(CONN_B, 'http://127.0.0.1:12345')],
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

  it('the management read answers unavailable rather than an empty graph', async () => {
    await expect(graph.getManagementGraph()).rejects.toMatchObject({ code: 'PROVIDER_GRAPH_UNAVAILABLE' });
  });

  it('a link is refused rather than silently queued', async () => {
    await expect(graph.linkBinding({ bindingId: BINDING, targetConnectionId: CONN_B }))
      .rejects.toMatchObject({ code: 'PROVIDER_GRAPH_UNAVAILABLE' });
    expect(store.relinkBinding).not.toHaveBeenCalled();
  });
});

describe('reconciliation', () => {
  it('is a no-op pass when the file and the graph already agree', async () => {
    await graph.initProviderGraph();
    expect(store.applyReconciliation).not.toHaveBeenCalled();
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

describe('linking', () => {
  beforeEach(() => graph.initProviderGraph());

  it('previews the difference without writing anything', async () => {
    const preview = await graph.previewBindingLink({ bindingId: BINDING, targetConnectionId: CONN_B });

    expect(preview.affectedRouteIds).toEqual(['claude-ollama']);
    expect(preview.revisions).toEqual({ binding: 1, sourceConnection: 1, targetConnection: 1 });
    expect(preview.requiresConfirmation).toBe(true);
    // Secrets never reach a preview; the browser learns only THAT they differ.
    expect(JSON.stringify(preview)).not.toContain('token-for-');
    expect(store.relinkBinding).not.toHaveBeenCalled();
  });

  it('stages the projection, writes the file, and acknowledges only then', async () => {
    const order = [];
    store.commitPendingProjection.mockImplementation(async () => { order.push('stage'); });
    providers.applyProviderPatches.mockImplementation(async (patches) => { order.push('write'); return Object.keys(patches); });
    store.acknowledgeProjection.mockImplementation(async () => { order.push('acknowledge'); });

    const result = await graph.linkBinding({
      bindingId: BINDING, targetConnectionId: CONN_B,
      expectedRevisions: { binding: 1, sourceConnection: 1, targetConnection: 1 },
    });

    expect(order).toEqual(['stage', 'write', 'acknowledge']);
    expect(result).toEqual({ bindingId: BINDING, connectionId: CONN_B, affectedRouteIds: ['claude-ollama'] });
    // The route keeps its executable id; only the backend it reaches moves.
    expect(providers.applyProviderPatches.mock.calls[0][0]['claude-ollama'].envVars).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345',
      ANTHROPIC_AUTH_TOKEN: 'token-for-22222222-2222-4222-8222-222222222222',
    });
  });

  it.each([
    ['binding', { binding: 9, sourceConnection: 1, targetConnection: 1 }],
    ['source connection', { binding: 1, sourceConnection: 9, targetConnection: 1 }],
    ['target connection', { binding: 1, sourceConnection: 1, targetConnection: 9 }],
  ])('refuses a stale %s revision before any row is touched', async (_label, expectedRevisions) => {
    await expect(graph.linkBinding({ bindingId: BINDING, targetConnectionId: CONN_B, expectedRevisions }))
      .rejects.toMatchObject({ status: 409, code: 'PROVIDER_GRAPH_STALE_REVISION' });
    expect(store.relinkBinding).not.toHaveBeenCalled();
  });

  it('refuses a binding whose projection is still unsettled', async () => {
    const fixture = graphFixture();
    fixture.routes[0].pending = { fields: {}, envVars: {}, hasEnvVars: true };
    store.readGraph.mockResolvedValue(fixture);

    await expect(graph.linkBinding({ bindingId: BINDING, targetConnectionId: CONN_B }))
      .rejects.toMatchObject({ code: 'PROVIDER_GRAPH_BINDING_BLOCKED' });
  });

  it('allocates a distinct variant when the target already has this harness on default', async () => {
    const fixture = graphFixture();
    fixture.bindings.push({
      id: '44444444-4444-4444-8444-444444444444', revision: 1, connectionId: CONN_B,
      harnessId: 'claude', variantKey: 'default', label: 'Other Claude', enabled: true, selectedModels: [],
    });
    store.readGraph.mockResolvedValue(fixture);

    const preview = await graph.previewBindingLink({ bindingId: BINDING, targetConnectionId: CONN_B });
    expect(preview.variantKey).toBe(`variant:${BINDING}`);
  });

  it('refuses a link a binding already has', async () => {
    await expect(graph.linkBinding({ bindingId: BINDING, targetConnectionId: CONN_A }))
      .rejects.toMatchObject({ code: 'PROVIDER_GRAPH_ALREADY_LINKED' });
  });
});

describe('unlinking', () => {
  beforeEach(() => graph.initProviderGraph());

  it('clones the shared connection under a new id and rewrites no route', async () => {
    const result = await graph.unlinkBinding({ bindingId: BINDING, expectedRevisions: { binding: 1 } });

    expect(result.bindingId).toBe(BINDING);
    expect(result.connectionId).not.toBe(CONN_A);
    const [{ connection: clone }] = store.detachBindingToConnection.mock.calls[0];
    expect(clone.transports).toEqual({ anthropic: { baseUrl: 'http://127.0.0.1:11434' } });
    expect(clone.credentials).toEqual({ ANTHROPIC_AUTH_TOKEN: `token-for-${CONN_A}` });
    // Nothing about execution changes, so the provider file is not touched.
    expect(providers.applyProviderPatches).not.toHaveBeenCalled();
  });

  it('refuses an unknown binding', async () => {
    await expect(graph.unlinkBinding({ bindingId: CONN_B })).rejects.toMatchObject({ code: 'BINDING_NOT_FOUND' });
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
