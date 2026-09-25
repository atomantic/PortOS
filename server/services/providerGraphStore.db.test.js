/**
 * Postgres round-trip for the provider connection graph (#6367).
 *
 * The reconciliation POLICY is pinned without a database in
 * `server/lib/providerGraphRecords.test.js`; what needs a real Postgres is the
 * part only Postgres enforces — the two partial unique indexes that keep
 * duplicate bindings out (a plain UNIQUE over a nullable `harness_id` would not,
 * because NULL never equals NULL), the `(binding_id, mode)` uniqueness, the
 * foreign keys that refuse an orphan, and the JSONB round-trip of a projection
 * snapshot.
 *
 * Runs via `npm run test:db` (→ `portos_test`) ONLY; the guards in
 * `server/lib/db.js` refuse row writes to a non-test database. Skips cleanly
 * when no database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((err) => ({ connected: false, error: err?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_route_bindings') AS ok",
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'ai_route_bindings table not present';
  }
}

const runDb = requireDbOrSkip('services/providerGraphStore.db.test', dbReady, skipReason);

const connection = (overrides = {}) => ({
  id: randomUUID(),
  revision: 1,
  kind: 'ollama',
  label: 'Example local daemon',
  transports: { anthropic: { baseUrl: 'http://127.0.0.1:11434' } },
  credentials: { ANTHROPIC_AUTH_TOKEN: 'example-token' },
  catalog: { state: 'known', models: ['example-model'] },
  ...overrides,
});

const binding = (connectionId, overrides = {}) => ({
  id: randomUUID(),
  revision: 1,
  connectionId,
  harnessId: 'claude',
  variantKey: 'default',
  label: 'Claude',
  enabled: true,
  selectedModels: ['example-model'],
  ...overrides,
});

const route = (bindingId, providerId, overrides = {}) => ({
  providerId,
  bindingId,
  mode: 'cli',
  modelMap: { 'example-model': 'example-model' },
  projected: { fields: {}, envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' }, hasEnvVars: true },
  pending: null,
  pendingRevision: null,
  ...overrides,
});

describe.skipIf(!runDb)('ai_* connection graph store', () => {
  let store;

  beforeAll(async () => {
    store = await import('./providerGraphStore.js');
  });

  beforeEach(async () => {
    await query('DELETE FROM ai_route_bindings');
    await query('DELETE FROM ai_harness_bindings');
    await query('DELETE FROM ai_connections');
  });

  afterAll(async () => {
    await query('DELETE FROM ai_route_bindings').catch(() => {});
    await query('DELETE FROM ai_harness_bindings').catch(() => {});
    await query('DELETE FROM ai_connections').catch(() => {});
    await close();
  });

  it('round-trips a whole graph, JSONB snapshots included', async () => {
    const conn = connection();
    const bind = binding(conn.id);
    await store.writeGraph({ connections: [conn], bindings: [bind], routes: [route(bind.id, 'claude-ollama')] });

    const read = await store.readGraph();
    expect(read.connections[0]).toMatchObject({
      id: conn.id, kind: 'ollama', transports: conn.transports, credentials: conn.credentials, catalog: conn.catalog,
    });
    expect(read.bindings[0]).toMatchObject({ id: bind.id, connectionId: conn.id, harnessId: 'claude', enabled: true });
    expect(read.routes[0]).toMatchObject({
      providerId: 'claude-ollama', bindingId: bind.id, mode: 'cli', pending: null,
    });
    // The projection snapshot must survive verbatim — it is the value a crash
    // recovery compares the provider file against.
    expect(read.routes[0].projected).toEqual(route(bind.id, 'x').projected);
  });

  it('keeps a hand-authored alias when an unrelated repair re-upserts the route', async () => {
    const conn = connection();
    const bind = binding(conn.id);
    await store.writeGraph({ connections: [conn], bindings: [bind], routes: [route(bind.id, 'claude-ollama')] });
    await store.saveRouteModelAliases('claude-ollama', { 'hand-written': 'example-model' });

    // An import, a reconciliation re-import and a binding split all carry no
    // overrides. If the conflict update took them from EXCLUDED, this would
    // silently delete a correction the user typed (#6369).
    await store.writeGraph({ connections: [], bindings: [], routes: [route(bind.id, 'claude-ollama')] });

    const read = await store.readGraph();
    expect(read.routes[0].modelAliasOverrides).toEqual({ 'hand-written': 'example-model' });
  });

  it('refuses two routes on one binding in the same mode', async () => {
    const conn = connection();
    const bind = binding(conn.id);
    await store.writeGraph({ connections: [conn], bindings: [bind], routes: [route(bind.id, 'claude-ollama')] });

    await expect(store.writeGraph({
      connections: [], bindings: [], routes: [route(bind.id, 'claude-ollama-duplicate')],
    })).rejects.toThrow(/uq_ai_route_bindings_binding_mode|duplicate key/i);
  });

  it('refuses a duplicate default binding for one harness on one connection', async () => {
    const conn = connection();
    await store.writeGraph({ connections: [conn], bindings: [binding(conn.id)], routes: [] });
    await query('INSERT INTO ai_harness_bindings (id, connection_id, harness_id, variant_key) VALUES ($1, $2, $3, $4)',
      [randomUUID(), conn.id, 'claude', 'variant:other']); // a distinct variant is fine

    await expect(query(
      'INSERT INTO ai_harness_bindings (id, connection_id, harness_id, variant_key) VALUES ($1, $2, $3, $4)',
      [randomUUID(), conn.id, 'claude', 'default'],
    )).rejects.toThrow(/uq_ai_harness_bindings_variant|duplicate key/i);
  });

  it('refuses a duplicate default API binding, which a nullable UNIQUE would allow', async () => {
    // NULL != NULL in a plain UNIQUE constraint, so without the partial index
    // an install could accumulate unlimited duplicate direct-API bindings.
    const conn = connection();
    await store.writeGraph({ connections: [conn], bindings: [], routes: [] });
    await query('INSERT INTO ai_harness_bindings (id, connection_id, harness_id, variant_key) VALUES ($1, $2, NULL, $3)',
      [randomUUID(), conn.id, 'default']);

    await expect(query(
      'INSERT INTO ai_harness_bindings (id, connection_id, harness_id, variant_key) VALUES ($1, $2, NULL, $3)',
      [randomUUID(), conn.id, 'default'],
    )).rejects.toThrow(/uq_ai_harness_bindings_api_variant|duplicate key/i);
  });

  it('refuses to delete a connection a binding still names, and allows the orphan', async () => {
    const conn = connection();
    const bind = binding(conn.id);
    await store.writeGraph({ connections: [conn], bindings: [bind], routes: [] });

    expect(await store.deleteConnection(conn.id)).toEqual({ deleted: false, reason: 'referenced-by-binding' });
    await query('DELETE FROM ai_harness_bindings WHERE id = $1', [bind.id]);
    expect(await store.deleteConnection(conn.id)).toEqual({ deleted: true });
  });

  it('folds a duplicate service: the binding moves on its freed variant key and the emptied row goes', async () => {
    // Both rows carry a `default` Claude binding, so the move must land on the
    // variant key the planner freed or the partial unique index refuses it.
    const keeper = connection();
    const twin = connection();
    const kept = binding(keeper.id);
    const moved = binding(twin.id);
    await store.writeGraph({ connections: [keeper, twin], bindings: [kept, moved], routes: [route(moved.id, 'claude-ollama')] });

    await store.mergeServiceInstances({
      keeper: { ...keeper, label: 'Ollama', catalog: { state: 'known', models: ['example-model', 'other-model'] } },
      absorbedIds: [twin.id],
      bindingMoves: [{ bindingId: moved.id, variantKey: `variant:${moved.id}` }],
    });

    const read = await store.readGraph();
    expect(read.connections.map((row) => row.id)).toEqual([keeper.id]);
    expect(read.connections[0]).toMatchObject({ label: 'Ollama', revision: 2, catalog: { models: ['example-model', 'other-model'] } });
    expect(read.bindings.find((row) => row.id === moved.id)).toMatchObject({ connectionId: keeper.id, variantKey: `variant:${moved.id}` });
    expect(read.routes[0]).toMatchObject({ providerId: 'claude-ollama', bindingId: moved.id });
  });

  it('stages, then acknowledges, a projection', async () => {
    const conn = connection();
    const bind = binding(conn.id);
    await store.writeGraph({ connections: [conn], bindings: [bind], routes: [route(bind.id, 'claude-ollama')] });
    const owned = { fields: {}, envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345' }, hasEnvVars: true };

    await store.commitPendingProjection([{ providerId: 'claude-ollama', owned }]);
    let read = await store.readGraph();
    expect(read.routes[0].pending).toEqual(owned);
    // Staging bumps the binding revision so a concurrent link sees a stale one.
    expect(read.bindings[0].revision).toBe(2);
    expect(read.routes[0].pendingRevision).toBe(2);

    await store.acknowledgeProjection(['claude-ollama']);
    read = await store.readGraph();
    expect(read.routes[0].pending).toBeNull();
    expect(read.routes[0].projected).toEqual(owned);
  });

  it('applies a reconciliation plan atomically: remove, clone, re-snapshot, import', async () => {
    const conn = connection();
    const bind = binding(conn.id);
    await store.writeGraph({
      connections: [conn],
      bindings: [bind],
      routes: [route(bind.id, 'claude-ollama'), route(bind.id, 'claude-ollama-tui', { mode: 'tui' })],
    });

    const cloned = connection({ transports: { anthropic: { baseUrl: 'http://127.0.0.1:12345' } } });
    const importedConnection = connection({ kind: 'api', credentials: {} });
    const importedBinding = binding(importedConnection.id, { harnessId: null, label: 'Remote' });
    const moved = { fields: {}, envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345' }, hasEnvVars: true };

    await store.applyReconciliation({
      removals: ['claude-ollama-tui'],
      regroups: [{
        routeIds: ['claude-ollama'], bindingId: bind.id, binding: null,
        connectionAction: 'clone', connection: cloned,
      }],
      snapshots: [{ providerId: 'claude-ollama', owned: moved }],
      acknowledgements: [],
      conflicts: [],
      imports: {
        connections: [importedConnection],
        bindings: [importedBinding],
        routes: [route(importedBinding.id, 'remote-ollama', { mode: 'api' })],
      },
    });

    const read = await store.readGraph();
    expect(read.routes.map((row) => row.providerId).sort()).toEqual(['claude-ollama', 'remote-ollama']);
    expect(read.bindings.find((row) => row.id === bind.id).connectionId).toBe(cloned.id);
    expect(read.routes.find((row) => row.providerId === 'claude-ollama').projected).toEqual(moved);
    // The original connection row is kept for explicit cleanup, not deleted.
    expect(read.connections.map((row) => row.id)).toContain(conn.id);
  });

  it('rolls the whole plan back when one statement fails', async () => {
    const conn = connection();
    const bind = binding(conn.id);
    await store.writeGraph({ connections: [conn], bindings: [bind], routes: [route(bind.id, 'claude-ollama')] });

    await expect(store.applyReconciliation({
      removals: [],
      regroups: [],
      snapshots: [],
      acknowledgements: [],
      conflicts: [],
      // A binding pointing at a connection that does not exist: the FK rejects
      // it, and the route insert before it must not survive.
      imports: {
        connections: [],
        bindings: [binding(randomUUID(), { id: randomUUID() })],
        routes: [],
      },
    })).rejects.toThrow();

    const read = await store.readGraph();
    expect(read.bindings).toHaveLength(1);
  });

  describe('service-instance columns (#7563)', () => {
    it('round-trips the columns and refuses two rows on one slug', async () => {
      const conn = connection({ slug: 'ollama', definitionId: 'ollama', plan: 'local', enabled: false, credentialVia: 'env' });
      await store.writeGraph({ connections: [conn], bindings: [], routes: [] });
      const [read] = (await store.readGraph()).connections;
      expect(read).toMatchObject({ slug: 'ollama', definitionId: 'ollama', plan: 'local', enabled: false, credentialVia: 'env' });

      await expect(store.writeGraph({ connections: [connection({ slug: 'ollama' })], bindings: [], routes: [] }))
        .rejects.toThrow(/uq_ai_connections_slug|duplicate key/i);
    });

    it('reads a row written without the columns with their defaults, and backfills it exactly once', async () => {
      const conn = connection();
      await store.writeGraph({ connections: [conn], bindings: [], routes: [] });
      let [read] = (await store.readGraph()).connections;
      // A pre-#7563 row: unnamed, on the column defaults — nothing else changed.
      expect(read).toMatchObject({ slug: null, definitionId: null, plan: 'paid', enabled: true, credentialVia: 'stored', revision: 1 });
      expect(read.transports).toEqual(conn.transports);
      expect(read.credentials).toEqual(conn.credentials);
      expect(read.catalog).toEqual(conn.catalog);

      await store.applyServiceColumnBackfill([{ id: conn.id, slug: 'ollama', definitionId: 'ollama', plan: 'local' }]);
      [read] = (await store.readGraph()).connections;
      expect(read).toMatchObject({ slug: 'ollama', definitionId: 'ollama', plan: 'local', revision: 1 });
      expect(read.credentials).toEqual(conn.credentials);

      // A re-run must not rename a row that is already named.
      await store.applyServiceColumnBackfill([{ id: conn.id, slug: 'ollama-9', definitionId: 'ollama', plan: 'local' }]);
      [read] = (await store.readGraph()).connections;
      expect(read.slug).toBe('ollama');
      // And an empty table plans and creates nothing.
      await store.applyServiceColumnBackfill([]);
    });

    it('preserves the instance columns when a regroup re-upserts the row without them', async () => {
      const conn = connection({ slug: 'ollama', definitionId: 'ollama', plan: 'local', enabled: false, credentialVia: 'bootstrap' });
      await store.writeGraph({ connections: [conn], bindings: [], routes: [] });
      // What `planGraphReconciliation` hands `applyReconciliation` for an
      // in-place update: the connection-owned values and nothing about the slug.
      const { slug, definitionId, plan, enabled, credentialVia, ...bare } = conn;
      await store.writeGraph({ connections: [{ ...bare, label: 'Renamed by reconcile' }], bindings: [], routes: [] });
      const [read] = (await store.readGraph()).connections;
      expect(read).toMatchObject({ label: 'Renamed by reconcile', slug: 'ollama', definitionId: 'ollama', plan: 'local', enabled: false, credentialVia: 'bootstrap' });
    });

    it('writes plan, enabled and credential mode through the settings save, and leaves them alone when unnamed', async () => {
      const conn = connection({ slug: 'ollama', definitionId: 'ollama', plan: 'local' });
      await store.writeGraph({ connections: [conn], bindings: [], routes: [] });
      await store.saveConnectionSettings({ ...conn, plan: 'local', enabled: false, credentialVia: 'cli-login' });
      let [read] = (await store.readGraph()).connections;
      expect(read).toMatchObject({ enabled: false, credentialVia: 'cli-login', revision: 2 });
      await store.saveConnectionSettings({ ...conn, label: 'Only the label' });
      [read] = (await store.readGraph()).connections;
      expect(read).toMatchObject({ label: 'Only the label', enabled: false, credentialVia: 'cli-login', plan: 'local' });
    });
  });
});
