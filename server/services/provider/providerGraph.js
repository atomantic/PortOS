import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import {
  providerConnectionProfile,
  projectConnectionOwnedFields,
  withConnectionOwnedFields,
} from '../../lib/provider/providerConnections.js';
import {
  connectionOwnedSnapshot,
  isDerivedPreset,
  mergeConnectionCredentials,
  planGraphReconciliation,
  reconciliationIsNoop,
  toConnectionDto,
} from '../../lib/provider/providerGraphRecords.js';
import {
  planPresetBackfill,
  presetBackfillVerdict,
  rederivePreset,
} from '../../lib/provider/providerPresets.js';
import { connectionBlocker } from '../../lib/provider/providerRouteRecipes.js';
import {
  instanceForConnection,
  planServiceColumnBackfill,
  serviceColumnsForConnection,
  takenServiceSlugs,
} from '../../lib/provider/providerServiceInstances.js';
import { planServiceInstanceMerges } from '../../lib/provider/providerServiceMerge.js';
import { SERVICE_CREDENTIAL_VIAS, assertServicePlan, serviceDefinitionById } from '../../lib/serviceDefinitions.js';
import { requireToolkit } from '../../lib/aiToolkitState.js';
import {
  acknowledgeProjection,
  applyReconciliation,
  applyServiceColumnBackfill,
  commitPendingProjection,
  deleteConnection,
  mergeServiceInstances,
  readGraph,
  saveConnectionSettings,
  writeGraph,
} from './providerGraphStore.js';

/**
 * The provider connection graph's orchestration layer (#6367).
 *
 * Two stores have to agree here and neither can be locked against the other:
 * the DB graph (`providerGraphStore.js`) and the executable
 * `data/providers.json` the toolkit owns. `providers.json` stays fully
 * materialized and authoritative for EXECUTION -- a downgraded release runs it
 * with no graph at all -- so every rule below is written from that direction:
 * the file is what a run reads, and the graph follows it.
 *
 * **Serialization.** Every pass runs on one promise queue, so a legacy provider
 * write, a boot reconcile and a link can never interleave their reads and
 * writes. This is re-entrancy control, not multi-actor locking (AGENTS.md
 * Security Model): there is one server process and one human.
 *
 * **Projection ordering.** A graph mutation commits its rows AND the pending
 * projection snapshot in one DB transaction, writes providers.json through the
 * toolkit, then acknowledges. A crash at any point leaves a `pending` snapshot
 * the next reconcile pass can resolve against the file's actual values --
 * retrying only when the file still holds the old value, and refusing outright
 * when it holds a third one.
 *
 * **No AI provider is ever contacted here.** Import, reconcile, link, unlink
 * and projection are local I/O only (AGENTS.md "No cold-bootstrap LLM calls").
 */

/** Off until the database phase says the graph tables exist. */
let graphEnabled = false;
/** Re-entrancy latch: a projection's own file write must not re-trigger a pass. */
let reconciling = false;
let queue = Promise.resolve();
/**
 * Why each routed legacy record stayed legacy on the LAST pass (#7565), by
 * provider id. The editor offers "Convert to derived preset" only where this
 * holds no reason: the conversion runs the very same pass, so a record the pass
 * just refused would refuse again (the pre-fix editor offered the button to
 * every shipped preset it could never convert).
 */
let presetSkipReasons = new Map();

/**
 * One-at-a-time execution. A rejected pass must not poison the next one.
 * Exported (as `serializeProviderGraph`) for the service-instance operations
 * in `providerServices.js`, which mutate the same rows.
 */
const serialize = (fn) => {
  queue = queue.then(() => undefined, () => undefined).then(fn);
  return queue;
};
export { serialize as serializeProviderGraph };

export const providerGraphEnabled = () => graphEnabled;

/** The reason the last pass left `providerId` a legacy preset, or null when it did not refuse it. */
export const presetSkipReason = (providerId) => presetSkipReasons.get(providerId) ?? null;

/** Test seam: reset module state between suites. */
export function resetProviderGraphState() {
  graphEnabled = false;
  reconciling = false;
  queue = Promise.resolve();
  presetSkipReasons = new Map();
}

const providerService = () => requireToolkit().services.providers;

// Deferred: the bootstrap-app table is read only when a preset is derived, and
// its module reaches the provider validation schemas — a closure nothing on the graph's
// boot path otherwise pays for (server/AGENTS.md "Import scoping").
const bootstrapApps = async () => (await import('../credentialBootstrapApps.js')).listCredentialBootstraps();

/**
 * A connection addressed by UUID or by service slug (#7563). Returns null
 * when neither matches.
 */
export const findConnectionByRef = (graph, ref) =>
  graph.connections.find((candidate) => candidate.id === ref || (candidate.slug != null && candidate.slug === ref)) ?? null;

/**
 * The patch that materializes a connection-owned snapshot into an executable
 * record. Built from the live record so unknown custom fields and route-owned
 * env vars survive untouched.
 */
function projectionPatch(provider, owned) {
  const merged = withConnectionOwnedFields(provider, owned);
  const patch = { ...owned.fields };
  if (owned.hasEnvVars) patch.envVars = merged.envVars;
  return patch;
}

/**
 * One reconciliation pass: read both stores, plan, apply.
 *
 * Retries are written to the file BEFORE the plan is applied so their rows can
 * be acknowledged in the same transaction -- a retry that could not be written
 * stays pending and is retried on the next pass rather than being marked done.
 */
async function reconcilePass(reason) {
  const graph = await readGraph();
  const { providers, activeProvider } = await providerService().getAllProviders();
  const plan = planGraphReconciliation(graph, providers, { mintId: randomUUID });

  if (plan.retries.length > 0) {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const patches = Object.fromEntries(plan.retries
      .filter(({ providerId }) => byId.has(providerId))
      .map(({ providerId, owned }) => [providerId, projectionPatch(byId.get(providerId), owned)]));
    const written = await providerService().applyProviderPatches(patches);
    plan.acknowledgements.push(...written.map((providerId) => ({ providerId })));
  }

  // Service-instance columns (#7563): a row written before they existed, an
  // imported fragment and a detached clone all arrive with no slug. The fresh
  // rows in the plan are named BEFORE it is applied, so they land addressed;
  // the pre-existing unnamed rows are backfilled after. Row-derived (never a
  // seed) and idempotent, so it rides every pass rather than a one-shot
  // migration. Local I/O only; nothing here contacts a provider.
  const taken = takenServiceSlugs(graph.connections);
  const harnessOf = (bindings, test) => bindings.find(test)?.harnessId ?? null;
  for (const connection of plan.imports.connections) {
    const harnessId = harnessOf(plan.imports.bindings, (binding) => binding.connectionId === connection.id);
    Object.assign(connection, serviceColumnsForConnection(connection, { harnessId, taken }));
  }
  for (const regroup of plan.regroups) {
    if (regroup.connectionAction !== 'clone') continue;
    const harnessId = regroup.binding?.harnessId ?? harnessOf(graph.bindings, (binding) => binding.id === regroup.bindingId);
    Object.assign(regroup.connection, serviceColumnsForConnection(regroup.connection, { harnessId, taken }));
  }
  const backfill = planServiceColumnBackfill(graph, taken);

  const noop = reconciliationIsNoop(plan);
  if (!noop) await applyReconciliation(plan);
  if (backfill.length > 0) {
    await applyServiceColumnBackfill(backfill);
    console.log(`🔗 Provider graph: named ${backfill.length} service instance(s) (${backfill.map((row) => row.slug).join(', ')})`);
  }

  // Derived presets (#7565): every legacy record the graph now routes onto a
  // named instance is stamped with its structural keys — when re-deriving it
  // from that service is a fixpoint. Row-derived like the slugs above, so it
  // rides every pass; the latch this pass holds keeps the file write from
  // re-entering. The view it reads is the graph AS APPLIED, composed from the
  // plan rather than re-read (one read per pass is the recursion guard the
  // save hook relies on): the rows this pass imported and the slugs it named
  // are eligible now, a clone or split waits for the next pass.
  const named = new Map(backfill.map((row) => [row.id, row]));
  const removed = new Set(plan.removals);
  const applied = {
    connections: [...graph.connections.map((connection) => ({ ...connection, ...(named.get(connection.id) || {}) })), ...plan.imports.connections],
    bindings: [...graph.bindings, ...plan.imports.bindings],
    routes: [...graph.routes.filter((route) => !removed.has(route.providerId)), ...plan.imports.routes],
  };
  const presets = await backfillPresets(applied, providers);
  presetSkipReasons = new Map(presets.skipped.map(({ id, reason }) => [id, reason]));

  // One service per backend (epic #7561): the import gave every harness its
  // own row, so fold rows that provably reach one backend under one set of
  // terms into a single instance. Row-derived and idempotent like the steps
  // above — a folded graph plans nothing — so it rides every pass. It reads
  // the same as-applied view, which a regroup (clone, split, in-place update)
  // leaves stale, so a pass that moved rows leaves the fold to the next one.
  const regrouped = plan.regroups.some((regroup) => regroup.connectionAction !== 'unchanged' || !regroup.bindingId);
  const folded = regrouped ? 0 : await foldDuplicateServices(applied, presets.stamped.length > 0 ? null : providers);

  const detached = plan.regroups.filter((regroup) => regroup.connectionAction === 'clone').length;
  const split = plan.regroups.filter((regroup) => !regroup.bindingId).length;
  if (!noop || plan.conflicts.length > 0 || presets.stamped.length > 0 || folded > 0) {
    console.log(`🔗 Provider graph reconciled (${reason}): ${plan.imports.routes.length} imported, `
      + `${detached} detached, ${split} split, ${plan.removals.length} removed, `
      + `${plan.acknowledgements.length} acknowledged, ${plan.conflicts.length} conflicted, ${presets.stamped.length} presets derived, `
      + `${folded} services folded`);
  }
  for (const conflict of plan.conflicts) {
    console.error(`⚠️ Provider route ${conflict.providerId} changed outside the graph mid-projection; `
      + 'leaving it untouched and blocking its binding until repaired');
  }
  return { activeProvider, plan, noop, presets };
}

/**
 * The service-fold half of a pass: `planServiceInstanceMerges` over the graph
 * as the steps above left it, applied one fold at a time. The provider file is
 * re-read only when the preset backfill just wrote it (`current` is null), so
 * the fold judges each record as derived or legacy by what it now is. Each
 * fold's derived presets are re-pointed in `providers.json` BEFORE the rows
 * move — they then name a slug that already exists, so a crash between the two
 * writes leaves every record resolvable and the next pass re-plans the same
 * fold. Writes through the toolkit directly, under the pass's latch, like
 * {@link backfillPresets}. Local I/O only.
 *
 * @returns {Promise<number>} how many rows were folded away
 */
async function foldDuplicateServices(graph, current) {
  const providers = current ?? (await providerService().getAllProviders()).providers;
  // Only a preset naming a bootstrap app consults the table.
  const bootstraps = providers.some((record) => record?.credentialBootstrapId) ? await bootstrapApps() : {};
  const merges = planServiceInstanceMerges(graph, providers, { bootstraps, env: process.env });
  for (const merge of merges) {
    if (Object.keys(merge.presetPatches).length > 0) await providerService().applyProviderPatches(merge.presetPatches);
    await mergeServiceInstances(merge);
    console.log(`🔗 Provider graph: folded service(s) ${merge.absorbedSlugs.join(', ')} into ${merge.keeper.slug}`);
  }
  return merges.reduce((sum, merge) => sum + merge.absorbedIds.length, 0);
}

/**
 * The preset backfill half of a pass (#7565). Writes through the toolkit
 * directly: the caller already holds the `reconciling` latch for the whole
 * pass, so the save hook this write fires returns immediately.
 *
 * @returns {Promise<{stamped: string[], skipped: {id: string, reason: string}[]}>}
 */
async function backfillPresets(graph, providers) {
  // The bootstrap table is read only when a legacy record is routed at all.
  const routed = new Set(graph.routes.map((route) => route.providerId));
  if (!providers.some((record) => routed.has(record?.id) && !isDerivedPreset(record))) return { stamped: [], skipped: [] };
  const { patches, skipped } = planPresetBackfill({ graph, providers, bootstraps: await bootstrapApps(), env: process.env });
  const stamped = Object.keys(patches).length > 0 ? await providerService().applyProviderPatches(patches) : [];
  if (stamped.length > 0) console.log(`🔗 Provider graph: derived ${stamped.length} preset(s) from their services (${stamped.join(', ')})`);
  // Aggregate only: a reason names a record, never a value off it.
  const legacy = skipped.filter(({ reason }) => reason !== 'unmapped').length;
  if (legacy > 0) console.log(`🔗 Provider graph: ${legacy} routed record(s) stay legacy presets`);
  return { stamped, skipped };
}

/**
 * Re-derive every DERIVED preset on `connection` from the row as it now is,
 * and write what changed (#7565). The complement of `projectRoutes`: that one
 * carries the endpoint and credential through the pending/projected snapshot
 * protocol, this one re-runs the whole materialization — the inline OpenCode
 * config, the plan-filtered catalog, the bootstrap app — none of which the
 * connection profile owns. Called from inside a serialized pass, after the row
 * is saved; a preset whose derivation is refused (the service lost its
 * endpoint, its bootstrap app was deleted) is left exactly as it was.
 *
 * @param {object} connection - the row as saved
 * @param {{providerIds?: string[]|null}} [options] - the derived presets to re-derive
 *   ONTO this row (a binding that just moved here), instead of the ones already naming it
 * @param {string|null} [options.resetPresetId] preset whose explicit refresh clears its model narrowing
 * @returns {Promise<string[]>} the preset ids rewritten
 */
export async function rematerializeDerivedPresets(connection, { providerIds = null, resetPresetId = null } = {}) {
  const instance = instanceForConnection(connection);
  if (!instance) return [];
  const [{ providers }, bootstraps] = await Promise.all([providerService().getAllProviders(), bootstrapApps()]);
  const onRow = (record) => (providerIds ? providerIds.includes(record.id) : record.serviceId === connection.slug);
  const patches = {};
  for (const record of providers) {
    if (!isDerivedPreset(record) || !onRow(record)) continue;
    // A preset refresh explicitly replaces its model list. Service refreshes
    // and sibling presets retain their declared narrowing.
    const candidate = record.id === resetPresetId ? { ...record, catalogNarrowing: null } : record;
    const patch = rederivePreset(candidate, { instance, catalog: connection.catalog, bootstraps, stored: record })?.patch;
    if (patch && Object.keys(patch).length > 0) patches[record.id] = patch;
  }
  if (Object.keys(patches).length === 0) return [];
  const written = await writeProviderPatches(patches);
  if (written.length > 0) console.log(`🔗 Re-derived ${written.length} preset(s) from service ${connection.slug}`);
  return written;
}

/**
 * Refresh the cached preset-conversion verdict — {@link presetSkipReason} —
 * for every LEGACY (not yet derived) record routed on `connection`, against
 * `connection` AS JUST SAVED (#8159).
 *
 * `presetSkipReasons` is otherwise updated only by a full reconcile pass
 * (`reconcilePass`, on boot or a `providers.json` write), so a connection
 * SETTINGS edit — which changes nothing `onProvidersSaved` watches — left the
 * "Convert to derived preset" gate answering against whatever the connection
 * looked like at the last pass. Scoped to `connection`'s own routes rather
 * than a whole-graph {@link planPresetBackfill}, because no OTHER route's
 * verdict can have changed from this edit; and to {@link presetBackfillVerdict}
 * rather than a write, because this is a read-cache refresh, not a conversion
 * — an eligible record still needs its own reconcile pass or explicit
 * "Convert" action to actually stamp.
 */
async function refreshPresetSkipReasonsForConnection(graph, connection) {
  const boundBindings = new Set(
    graph.bindings.filter((binding) => binding.connectionId === connection.id).map((binding) => binding.id),
  );
  const routes = graph.routes.filter((route) => boundBindings.has(route.bindingId));
  if (routes.length === 0) return;
  const { providers } = await providerService().getAllProviders();
  const byId = new Map(providers.map((record) => [record.id, record]));
  const legacy = routes
    .map((route) => ({ route, record: byId.get(route.providerId) }))
    .filter(({ record }) => record && typeof record === 'object' && !isDerivedPreset(record));
  if (legacy.length === 0) return;
  const instance = instanceForConnection(connection, process.env);
  const bootstraps = await bootstrapApps();
  for (const { route, record } of legacy) {
    const { reason } = presetBackfillVerdict(record, { route, connection, instance, bootstraps, env: process.env });
    if (reason) presetSkipReasons.set(record.id, reason);
    else presetSkipReasons.delete(record.id);
  }
}

/**
 * Reconcile the graph against providers.json.
 *
 * `reconciling` is set for the WHOLE pass, not just its write: the retry path
 * saves through the toolkit, which fires the same hook that calls this -- the
 * latch is what keeps that from recursing.
 */
export function reconcileProviderGraph(reason = 'manual') {
  if (!graphEnabled || reconciling) return Promise.resolve(null);
  return serialize(() => {
    reconciling = true;
    return reconcilePass(reason).finally(() => { reconciling = false; });
  });
}

/**
 * Boot entry, called from the database phase once the schema is up.
 *
 * The first pass on an install with no graph rows imports every provider record
 * -- including disabled and custom ones -- because each is simply "unmapped" to
 * the planner. That keeps ONE code path responsible for import, crash recovery
 * and downgrade reconciliation, so they cannot drift apart.
 */
export async function initProviderGraph() {
  graphEnabled = true;
  return reconcileProviderGraph('boot');
}

/**
 * The toolkit's post-save hook (wired in `bootstrap.js`).
 *
 * An old client's `PATCH /api/providers/:id` knows nothing about the graph, so
 * a connection-owned edit arrives here as a plain file change. Reconciliation
 * detaches the affected binding rather than letting the edit silently repoint
 * another harness's backend; a mode-only edit changes no connection-owned value
 * and is therefore route-scoped and a no-op here; and a deleted record drops
 * its row without being resurrected.
 */
export const onProvidersSaved = () => reconcileProviderGraph('legacy-write');

export const requireProviderGraph = () => {
  if (!graphEnabled) {
    throw new ServerError('Provider connection graph is unavailable on this install', { status: 503, code: 'PROVIDER_GRAPH_UNAVAILABLE' });
  }
};

const requireConnection = (graph, ref) => {
  const connection = findConnectionByRef(graph, ref);
  if (!connection) throw new ServerError('Connection not found', { status: 404, code: 'CONNECTION_NOT_FOUND' });
  return connection;
};

const stale = (what) => new ServerError(
  `${what} changed since the preview was taken; take a new preview`,
  { status: 409, code: 'PROVIDER_GRAPH_STALE_REVISION' });

/**
 * Delete a connection nothing binds any more.
 *
 * Reconciliation deliberately KEEPS an emptied connection rather than
 * garbage-collecting it — a backend the user configured is not something to
 * remove because a route was temporarily deleted. This is the explicit cleanup
 * that keeps them from accumulating forever, and it is refused while a binding
 * still names the row, so no binding is ever silently orphaned.
 */
export async function removeConnection(connectionRef) {
  requireProviderGraph();
  return serialize(async () => {
    const connectionId = requireConnection(await readGraph(), connectionRef).id;
    const result = await deleteConnection(connectionId);
    if (!result.deleted) {
      throw new ServerError('This connection is still used by a harness binding',
        { status: 409, code: 'PROVIDER_GRAPH_CONNECTION_IN_USE' });
    }
    console.log(`🔗 Deleted unused provider connection ${connectionId}`);
    return result;
  });
}

/**
 * Stage, write, acknowledge -- the three-step projection the crash-recovery
 * contract depends on. Never call the steps separately.
 */
async function projectRoutes(providerIds, connection) {
  const { providers } = await providerService().getAllProviders();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const projections = providerIds
    .filter((providerId) => byId.has(providerId))
    .map((providerId) => ({ providerId, owned: projectConnectionOwnedFields(byId.get(providerId), connection) }));
  if (projections.length === 0) return [];

  await commitPendingProjection(projections);
  const written = await writeProviderPatches(Object.fromEntries(
    projections.map(({ providerId, owned }) => [providerId, projectionPatch(byId.get(providerId), owned)]),
  ));
  await acknowledgeProjection(written);
  return written;
}

/**
 * Write `providers.json` from INSIDE a serialized graph pass.
 *
 * The latch is load-bearing, not defensive: the toolkit's post-save hook calls
 * back into `reconcileProviderGraph`, which queues behind the pass currently
 * awaiting this write. Holding `reconciling` makes that call return
 * immediately, so the pass cannot wait on work that is waiting on the pass.
 *
 * @param {Record<string, object>} patches - provider id → partial update
 * @returns {Promise<string[]>} the ids that existed and were written
 */
function writeProviderPatches(patches) {
  return duringProviderWrite(() => providerService().applyProviderPatches(patches));
}

/**
 * Hold the re-entrancy latch across any provider-file write made from inside a
 * serialized pass — a projection patch, or a freshly minted route.
 *
 * See {@link writeProviderPatches} for why this is load-bearing rather than
 * defensive: the toolkit's post-save hook calls back into the graph, and
 * without the latch that call would queue behind the pass awaiting this write.
 */
function duringProviderWrite(work) {
  reconciling = true;
  return Promise.resolve().then(work).finally(() => { reconciling = false; });
}

/**
 * Refuse a mutation while any of these routes is mid-projection.
 *
 * That state is precisely where the graph and `providers.json` disagree, so an
 * connection edit must wait until its routes agree with the graph.
 */
function requireSettledRoutes(routes) {
  if (routes.some((route) => route.pending)) {
    throw new ServerError('This connection has an unresolved projection and cannot be changed yet',
      { status: 409, code: 'PROVIDER_GRAPH_BINDING_BLOCKED' });
  }
}

/** Every binding on a connection, and the executable routes those bindings own. */
export function connectionFanout(graph, connectionId) {
  const bindings = graph.bindings.filter((binding) => binding.connectionId === connectionId);
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  return { bindings, routes: graph.routes.filter((route) => bindingIds.has(route.bindingId)) };
}

/**
 * Edit one shared backend: its label, its transports, its credentials.
 *
 * This is the whole point of the graph — the endpoint and secret a human
 * changes here are materialized into EVERY route on the connection in one
 * projection, instead of being retyped per harness and drifting. Route ids,
 * mode settings, pins, `activeProvider` and fallback references are untouched.
 *
 * A stale `expectedRevision` is a 409, not a last-writer merge: the human was
 * editing values they had read, and a moved row means they were not.
 *
 * `transports` replaces the map WHOLESALE rather than merging into it, so
 * dropping a protocol is expressible. That is why the editor renders one field
 * per declared transport and sends them all back: a client that sends a partial
 * map is asking to remove the rest.
 */
export function updateConnectionSettings({
  connectionId, expectedRevision, label, transports, credentials, plan, enabled, credentialVia,
}) {
  return serialize(async () => {
    requireProviderGraph();
    const graph = await readGraph();
    const connection = requireConnection(graph, connectionId);
    if (connection.revision !== expectedRevision) throw stale('The connection');
    const definition = connection.definitionId ? serviceDefinitionById(connection.definitionId) : null;
    // A row with no definition takes any plan: there is nothing to check it
    // against, and refusing would strand a legacy row a human is labelling.
    if (plan !== undefined && definition) assertServicePlan(definition, plan);
    if (credentialVia !== undefined && !SERVICE_CREDENTIAL_VIAS.includes(credentialVia)) {
      throw new ServerError(`credentialVia must be one of ${SERVICE_CREDENTIAL_VIAS.join(', ')}`,
        { status: 400, code: 'PROVIDER_SERVICE_CREDENTIAL_VIA_INVALID' });
    }
    const { routes } = connectionFanout(graph, connection.id);
    requireSettledRoutes(routes);

    const merged = mergeConnectionCredentials(connection.credentials, credentials);
    if (merged.rejected.length > 0) {
      throw new ServerError(
        `Send the real value or null for ${merged.rejected.join(', ')} — a redacted placeholder is not a credential`,
        { status: 400, code: 'PROVIDER_GRAPH_REDACTED_CREDENTIAL' });
    }

    const nextVia = credentialVia ?? connection.credentialVia;
    const next = {
      ...connection,
      label: label ?? connection.label,
      transports: transports ?? connection.transports,
      // A `bootstrap` instance stores no secret by definition: the launch
      // wrapper supplies it at spawn. Switching to it drops whatever was held.
      credentials: nextVia === 'bootstrap' ? {} : merged.credentials,
      plan: plan ?? connection.plan,
      enabled: enabled ?? connection.enabled,
      credentialVia: nextVia,
    };
    const revision = await saveConnectionSettings(next);
    const saved = { ...next, revision: revision ?? next.revision };
    const applied = await projectRoutes(routes.map((route) => route.providerId), next);
    // The derived presets on this instance follow the whole row, not only the
    // profile-owned half the projection carried (#7565).
    const rederived = await rematerializeDerivedPresets(saved);
    // This connection's still-legacy routes may have just become convertible,
    // or stopped being — keep `presetSkipReason` current rather than leaving
    // it to the next full reconcile pass, which this write never triggers (#8159).
    await refreshPresetSkipReasonsForConnection(graph, saved);
    console.log(`🔗 Updated connection ${connection.id} (${applied.length} routes projected, ${rederived.length} presets re-derived)`);
    return { connectionId: connection.id, revision, affectedRouteIds: [...new Set([...applied, ...rederived])] };
  });
}

/**
 * Create a new backend connection.
 *
 * Deliberately NOT deduplicated against the connections already stored. Two
 * backends that look identical — same vendor, same model names, even the same
 * URL reached differently — are still two backends until a human says
 * otherwise, and inferring otherwise is exactly what the identity rules in
 * `providerConnections.js` exist to forbid. Linking stays an explicit,
 * previewed act.
 *
 * The catalog starts `unknown`, not empty: nothing has been asked yet, and
 * `[]` would claim a backend with no models. Discovery is the separate,
 * explicitly requested service model refresh.
 */
export function createConnection({ kind, label, transports, credentials }) {
  return serialize(async () => {
    requireProviderGraph();
    const blocker = connectionBlocker({ kind, transports });
    if (blocker) throw new ServerError(blocker.message, { status: 400, code: blocker.code });
    const graph = await readGraph();
    const connection = {
      id: randomUUID(),
      revision: 1,
      kind,
      label,
      transports,
      credentials: credentials || {},
      catalog: { state: 'unknown', models: [] },
      // Named as a service instance from the start (#7563), so the row is
      // addressable without waiting for the next reconcile pass.
      ...serviceColumnsForConnection({ kind }, { taken: takenServiceSlugs(graph.connections) }),
      enabled: true,
      credentialVia: 'stored',
    };
    await writeGraph({ connections: [connection], bindings: [], routes: [] });
    console.log(`🔗 Created provider connection ${connection.id} (${kind}, no routes yet)`);
    return { connection: toConnectionDto(connection) };
  });
}
