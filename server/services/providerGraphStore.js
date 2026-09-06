import { query, withTransaction } from '../lib/db.js';

/**
 * Postgres adapter for the provider connection graph — `ai_connections`,
 * `ai_harness_bindings`, `ai_route_bindings` (#6367).
 *
 * db-primary per `docs/STORAGE.md`: app-native relational identities with real
 * foreign keys, not an externally edited file. **Machine-local — never
 * federated**: every row names this host's endpoints, credentials and execution
 * environment (ADR `docs/decisions/2026-08-08-privacy-records-machine-local.md`).
 * No `sync_sequence`, no tombstones, no `PORTOS_SCHEMA_VERSIONS` entry. Covered
 * by the normal Postgres dump in backup, like every other db-primary table.
 *
 * This module is only row I/O and revision checks. The projection engine, the
 * reconciliation policy and the serialization against legacy provider writes
 * all live in `providerGraph.js`; the pure planning lives in
 * `server/lib/providerGraphRecords.js`. Keeping the split means the interesting
 * decisions are testable without a database.
 *
 * Every write here runs inside one transaction, so a graph revision and its
 * pending projection snapshot commit together or not at all — that atomicity is
 * what makes an interrupted file write recoverable rather than ambiguous.
 */

const connectionRow = (row) => ({
  id: row.id,
  revision: row.revision,
  kind: row.kind,
  label: row.label,
  transports: row.transports || {},
  credentials: row.credentials || {},
  catalog: row.catalog || { state: 'unknown', models: [] },
});

const bindingRow = (row) => ({
  id: row.id,
  revision: row.revision,
  connectionId: row.connection_id,
  harnessId: row.harness_id,
  variantKey: row.variant_key,
  label: row.label,
  enabled: row.enabled,
  selectedModels: row.selected_models || [],
});

const routeRow = (row) => ({
  providerId: row.provider_id,
  bindingId: row.binding_id,
  mode: row.mode,
  modelMap: row.model_map || {},
  projected: row.projected || {},
  pending: row.pending ?? null,
  pendingRevision: row.pending_revision ?? null,
});

/** The whole graph. Small by nature — one row per configured route. */
export async function readGraph() {
  const [connections, bindings, routes] = await Promise.all([
    query('SELECT * FROM ai_connections ORDER BY created_at, id'),
    query('SELECT * FROM ai_harness_bindings ORDER BY created_at, id'),
    query('SELECT * FROM ai_route_bindings ORDER BY provider_id'),
  ]);
  return {
    connections: connections.rows.map(connectionRow),
    bindings: bindings.rows.map(bindingRow),
    routes: routes.rows.map(routeRow),
  };
}

const upsertConnection = (client, connection) => client.query(
  `INSERT INTO ai_connections (id, revision, kind, label, transports, credentials, catalog, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
   ON CONFLICT (id) DO UPDATE SET
     revision = ai_connections.revision + 1,
     kind = EXCLUDED.kind, label = EXCLUDED.label,
     transports = EXCLUDED.transports, credentials = EXCLUDED.credentials,
     catalog = EXCLUDED.catalog, updated_at = NOW()`,
  [connection.id, connection.revision ?? 1, connection.kind, connection.label ?? '',
    JSON.stringify(connection.transports || {}), JSON.stringify(connection.credentials || {}),
    JSON.stringify(connection.catalog || { state: 'unknown', models: [] })],
);

const upsertBinding = (client, binding) => client.query(
  `INSERT INTO ai_harness_bindings
     (id, revision, connection_id, harness_id, variant_key, label, enabled, selected_models, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
   ON CONFLICT (id) DO UPDATE SET
     revision = ai_harness_bindings.revision + 1,
     connection_id = EXCLUDED.connection_id, harness_id = EXCLUDED.harness_id,
     variant_key = EXCLUDED.variant_key, label = EXCLUDED.label,
     enabled = EXCLUDED.enabled, selected_models = EXCLUDED.selected_models, updated_at = NOW()`,
  [binding.id, binding.revision ?? 1, binding.connectionId, binding.harnessId ?? null,
    binding.variantKey, binding.label ?? '', binding.enabled === true,
    JSON.stringify(binding.selectedModels || [])],
);

const upsertRoute = (client, route) => client.query(
  `INSERT INTO ai_route_bindings
     (provider_id, binding_id, mode, model_map, projected, pending, pending_revision, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
   ON CONFLICT (provider_id) DO UPDATE SET
     binding_id = EXCLUDED.binding_id, mode = EXCLUDED.mode, model_map = EXCLUDED.model_map,
     projected = EXCLUDED.projected, pending = EXCLUDED.pending,
     pending_revision = EXCLUDED.pending_revision, updated_at = NOW()`,
  [route.providerId, route.bindingId, route.mode, JSON.stringify(route.modelMap || {}),
    JSON.stringify(route.projected || {}),
    route.pending == null ? null : JSON.stringify(route.pending),
    route.pendingRevision ?? null],
);

/**
 * Insert a freshly built graph in one transaction.
 *
 * Writes exactly what it is handed — a fragment with no routes is legitimate
 * (an emptied binding kept for explicit cleanup), so this must not short-circuit
 * on an empty route list.
 */
export async function writeGraph({ connections, bindings, routes }) {
  await withTransaction(async (client) => {
    for (const connection of connections) await upsertConnection(client, connection);
    for (const binding of bindings) await upsertBinding(client, binding);
    for (const route of routes) await upsertRoute(client, route);
  });
  return { connections: connections.length, bindings: bindings.length, routes: routes.length };
}

/**
 * Apply one reconciliation plan atomically.
 *
 * Ordering inside the transaction is load-bearing: connections before the
 * bindings that reference them, bindings before their routes, and route
 * REMOVALS before anything else so a deleted provider's row can never collide
 * with a re-import of the same id.
 *
 * Conflicts are deliberately not applied — a route whose file value matches
 * neither snapshot keeps its `pending` row untouched, which is exactly what
 * marks its binding blocked on the next read.
 */
export async function applyReconciliation(plan) {
  await withTransaction(async (client) => {
    if (plan.removals.length > 0) {
      await client.query('DELETE FROM ai_route_bindings WHERE provider_id = ANY($1::text[])', [plan.removals]);
    }

    for (const regroup of plan.regroups) {
      if (regroup.connectionAction !== 'unchanged') await upsertConnection(client, regroup.connection);
      const bindingId = regroup.binding?.id ?? regroup.bindingId;
      if (regroup.binding) {
        await upsertBinding(client, { ...regroup.binding, connectionId: regroup.connection.id });
        await client.query(
          'UPDATE ai_route_bindings SET binding_id = $1, updated_at = NOW() WHERE provider_id = ANY($2::text[])',
          [bindingId, regroup.routeIds],
        );
      } else if (regroup.connectionAction === 'clone') {
        await client.query(
          'UPDATE ai_harness_bindings SET connection_id = $1, revision = revision + 1, updated_at = NOW() WHERE id = $2',
          [regroup.connection.id, bindingId],
        );
      }
    }

    for (const { providerId, owned } of plan.snapshots) {
      await client.query(
        'UPDATE ai_route_bindings SET projected = $1, updated_at = NOW() WHERE provider_id = $2',
        [JSON.stringify(owned), providerId],
      );
    }

    for (const { providerId } of plan.acknowledgements) {
      await client.query(
        `UPDATE ai_route_bindings
            SET projected = pending, pending = NULL, pending_revision = NULL, updated_at = NOW()
          WHERE provider_id = $1`,
        [providerId],
      );
    }

    for (const connection of plan.imports.connections) await upsertConnection(client, connection);
    for (const binding of plan.imports.bindings) await upsertBinding(client, binding);
    for (const route of plan.imports.routes) await upsertRoute(client, route);
  });
}

/**
 * Stage a projection: bump the named rows' revisions and record the snapshot
 * each route is ABOUT to receive, in one transaction. The file write happens
 * after this returns; {@link acknowledgeProjection} closes the loop.
 */
export async function commitPendingProjection(projections) {
  if (projections.length === 0) return;
  await withTransaction(async (client) => {
    for (const { providerId, owned } of projections) {
      const { rows } = await client.query(
        `UPDATE ai_route_bindings SET pending = $1, updated_at = NOW() WHERE provider_id = $2
           RETURNING binding_id`,
        [JSON.stringify(owned), providerId],
      );
      if (rows.length === 0) continue;
      const { rows: bumped } = await client.query(
        'UPDATE ai_harness_bindings SET revision = revision + 1, updated_at = NOW() WHERE id = $1 RETURNING revision',
        [rows[0].binding_id],
      );
      await client.query('UPDATE ai_route_bindings SET pending_revision = $1 WHERE provider_id = $2',
        [bumped[0]?.revision ?? null, providerId]);
    }
  });
}

/** Promote every named route's pending snapshot to `projected`. */
export async function acknowledgeProjection(providerIds) {
  if (providerIds.length === 0) return;
  await query(
    `UPDATE ai_route_bindings
        SET projected = COALESCE(pending, projected), pending = NULL, pending_revision = NULL, updated_at = NOW()
      WHERE provider_id = ANY($1::text[])`,
    [providerIds],
  );
}

/** Repoint one binding at another connection. Revision-checked by the caller. */
export async function relinkBinding({ bindingId, connectionId }) {
  await withTransaction(async (client) => {
    await client.query(
      'UPDATE ai_harness_bindings SET connection_id = $1, revision = revision + 1, updated_at = NOW() WHERE id = $2',
      [connectionId, bindingId],
    );
    await client.query('UPDATE ai_connections SET revision = revision + 1, updated_at = NOW() WHERE id = $1',
      [connectionId]);
  });
}

/** Attach a binding to a freshly cloned connection (the unlink half). */
export async function detachBindingToConnection({ bindingId, connection }) {
  await withTransaction(async (client) => {
    await upsertConnection(client, connection);
    await client.query(
      'UPDATE ai_harness_bindings SET connection_id = $1, revision = revision + 1, updated_at = NOW() WHERE id = $2',
      [connection.id, bindingId],
    );
  });
}

/** Hard-delete an orphan connection. Refused while a binding still names it. */
export async function deleteConnection(connectionId) {
  const { rows } = await query('SELECT 1 FROM ai_harness_bindings WHERE connection_id = $1 LIMIT 1', [connectionId]);
  if (rows.length > 0) return { deleted: false, reason: 'referenced-by-binding' };
  await query('DELETE FROM ai_connections WHERE id = $1', [connectionId]);
  return { deleted: true };
}

// --- explicit management mutations (#6369) -----------------------------------
// Every function below is revision-checked and serialized by `providerGraph.js`
// BEFORE it is called. They write a whole row rather than a computed SET list:
// the caller already read the row it is replacing, so a partial-column update
// would only add a second place for the merge rules to live.

/**
 * Write a connection's user-editable settings and bump its revision.
 *
 * `catalog` is written here too because a refresh is a connection-level edit,
 * not a per-route one — see `refreshConnectionCatalog`.
 *
 * @returns {Promise<number|null>} the new revision, or `null` if the row is gone
 */
export async function saveConnectionSettings({ id, label, transports, credentials, catalog }) {
  const { rows } = await query(
    `UPDATE ai_connections
        SET label = $2, transports = $3, credentials = $4, catalog = $5,
            revision = revision + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING revision`,
    [id, label ?? '', JSON.stringify(transports || {}), JSON.stringify(credentials || {}),
      JSON.stringify(catalog || { state: 'unknown', models: [] })],
  );
  return rows[0]?.revision ?? null;
}

/**
 * Write a binding's management settings and bump its revision.
 *
 * Deliberately NOT `enabled`: route enablement is an executable-record field
 * that `PATCH /api/providers/:id` owns, and projecting a binding-level toggle
 * into it would turn a management edit into an execution consent grant.
 *
 * @returns {Promise<number|null>} the new revision, or `null` if the row is gone
 */
export async function saveBindingSettings({ id, label, selectedModels }) {
  const { rows } = await query(
    `UPDATE ai_harness_bindings
        SET label = $2, selected_models = $3, revision = revision + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING revision`,
    [id, label ?? '', JSON.stringify(selectedModels || [])],
  );
  return rows[0]?.revision ?? null;
}

/** Record the canonical→executable model aliases a refresh observed on a route. */
export async function saveRouteModelMap(providerId, modelMap) {
  await query('UPDATE ai_route_bindings SET model_map = $2, updated_at = NOW() WHERE provider_id = $1',
    [providerId, JSON.stringify(modelMap || {})]);
}
