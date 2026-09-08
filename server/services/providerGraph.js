import { randomUUID } from 'node:crypto';
import { ServerError } from '../lib/errorHandler.js';
import {
  compareBackendEndpoints,
  providerConnectionProfile,
  projectConnectionOwnedFields,
  withConnectionOwnedFields,
} from '../lib/providerConnections.js';
import {
  connectionOwnedSnapshot,
  mergeConnectionCredentials,
  nextConnectionCatalog,
  planGraphReconciliation,
  reconciliationIsNoop,
  routeBelongsOnConnection,
  sanitizeCatalogError,
  toConnectionDto,
  toManagementGraphDto,
} from '../lib/providerGraphRecords.js';
import { resolveRouteModels } from '../lib/providerGraphPreview.js';
import {
  applyModelAliasPatch,
  connectionCatalogModels,
  effectiveModelAliases,
  modelAliasRevision,
} from '../lib/providerModelAliases.js';
import { harnessById } from '../lib/providerHarnesses.js';
import { effortLevelsForProvider } from '../lib/providerModels.js';
import {
  bindingBlocker,
  buildRouteRecord,
  connectionBlocker,
  connectionKindLabel,
  mintRouteIds,
} from '../lib/providerRouteRecipes.js';
import {
  routeSettingsFor,
  routeSettingsRevision,
  unsupportedRouteSettings,
} from '../lib/providerRouteSettings.js';
import { buildTuiShellLaunch } from '../lib/tuiShellLaunch.js';
import { requireToolkit } from '../lib/aiToolkitState.js';
import {
  acknowledgeProjection,
  applyReconciliation,
  commitPendingProjection,
  deleteConnection,
  detachBindingToConnection,
  readGraph,
  relinkBinding,
  saveBindingSettings,
  saveConnectionSettings,
  saveRouteModelAliases,
  saveRouteModelMap,
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

/** One-at-a-time execution. A rejected pass must not poison the next one. */
const serialize = (fn) => {
  queue = queue.then(() => undefined, () => undefined).then(fn);
  return queue;
};

export const providerGraphEnabled = () => graphEnabled;

/** Test seam: reset module state between suites. */
export function resetProviderGraphState() {
  graphEnabled = false;
  reconciling = false;
  queue = Promise.resolve();
}

const providerService = () => requireToolkit().services.providers;

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

  const noop = reconciliationIsNoop(plan);
  if (!noop) await applyReconciliation(plan);

  const detached = plan.regroups.filter((regroup) => regroup.connectionAction === 'clone').length;
  const split = plan.regroups.filter((regroup) => !regroup.bindingId).length;
  if (!noop || plan.conflicts.length > 0) {
    console.log(`🔗 Provider graph reconciled (${reason}): ${plan.imports.routes.length} imported, `
      + `${detached} detached, ${split} split, ${plan.removals.length} removed, `
      + `${plan.acknowledgements.length} acknowledged, ${plan.conflicts.length} conflicted`);
  }
  for (const conflict of plan.conflicts) {
    console.error(`⚠️ Provider route ${conflict.providerId} changed outside the graph mid-projection; `
      + 'leaving it untouched and blocking its binding until repaired');
  }
  return { activeProvider, plan, noop };
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

/**
 * What one executable record contributes to its route's DTO: the overrides this
 * mode carries, the effort ladder its harness really accepts, and — for a
 * launchable TUI — the command line the Shell page would show.
 *
 * The command line is DISPLAY ONLY and its env half is dropped here: a launch
 * goes through `shell:start { providerId }`, which re-resolves both server-side,
 * so the provider's secret env never reaches a management payload.
 */
function describeRoute(provider) {
  const settings = routeSettingsFor(provider);
  return {
    settings,
    effortLevels: effortLevelsForProvider(provider, settings.defaultModel ?? null),
    tuiCommandLine: buildTuiShellLaunch(provider)?.commandLine ?? null,
    // The record's own model strings, so the DTO can say which hand-authored
    // aliases name a spelling this route no longer carries (#6369).
    storedModels: Array.isArray(provider?.models) ? provider.models : null,
  };
}

/** The sanitized `GET /api/providers/management` body. */
export async function getManagementGraph() {
  requireGraph();
  const [graph, data] = await Promise.all([readGraph(), providerService().getAllProviders()]);
  // Only the records the graph actually routes: an unmapped legacy provider has
  // no row to decorate, and resolving a shell invocation for it would be work
  // this response throws away.
  const byId = new Map(data.providers.map((provider) => [provider.id, provider]));
  const routeSettings = new Map(graph.routes
    .filter((route) => byId.has(route.providerId))
    .map((route) => [route.providerId, describeRoute(byId.get(route.providerId))]));
  return toManagementGraphDto({ ...graph, activeProvider: data.activeProvider, routeSettings });
}

// --- link / unlink -----------------------------------------------------------

const requireGraph = () => {
  if (!graphEnabled) {
    throw new ServerError('Provider connection graph is unavailable on this install', { status: 503, code: 'PROVIDER_GRAPH_UNAVAILABLE' });
  }
};

const stale = (what) => new ServerError(
  `${what} changed since the preview was taken; take a new preview`,
  { status: 409, code: 'PROVIDER_GRAPH_STALE_REVISION' });

/**
 * Resolve and revision-check every row a link touches.
 *
 * All three revisions are checked -- binding, source connection and target
 * connection -- because a link is a decision about a difference the human just
 * reviewed. Any of the three moving invalidates that review, so a stale one is
 * a 409 requiring a fresh preview rather than a last-writer merge.
 */
async function resolveLink({ bindingId, targetConnectionId = null, expectedRevisions = {} }) {
  requireGraph();
  const graph = await readGraph();
  const binding = graph.bindings.find((candidate) => candidate.id === bindingId);
  if (!binding) throw new ServerError('Binding not found', { status: 404, code: 'BINDING_NOT_FOUND' });
  const source = graph.connections.find((candidate) => candidate.id === binding.connectionId) || null;
  const target = targetConnectionId
    ? graph.connections.find((candidate) => candidate.id === targetConnectionId) || null
    : null;
  if (targetConnectionId && !target) throw new ServerError('Connection not found', { status: 404, code: 'CONNECTION_NOT_FOUND' });
  if (target && target.id === binding.connectionId) {
    throw new ServerError('That binding already uses this connection', { status: 409, code: 'PROVIDER_GRAPH_ALREADY_LINKED' });
  }

  // A route mid-projection is precisely the state where the graph and the file
  // disagree, so a link decided against it would be decided against unknown
  // values. Refuse until reconciliation settles it.
  if (graph.routes.some((route) => route.bindingId === bindingId && route.pending)) {
    throw new ServerError('This binding has an unresolved projection and cannot be changed yet',
      { status: 409, code: 'PROVIDER_GRAPH_BINDING_BLOCKED' });
  }

  if (expectedRevisions.binding !== undefined && expectedRevisions.binding !== binding.revision) throw stale('The binding');
  if (expectedRevisions.sourceConnection !== undefined && expectedRevisions.sourceConnection !== source?.revision) {
    throw stale('The source connection');
  }
  if (target && expectedRevisions.targetConnection !== undefined && expectedRevisions.targetConnection !== target.revision) {
    throw stale('The target connection');
  }
  return { graph, binding, source, target };
}

/** A connection row in the shape the endpoint comparator expects. */
const asProfile = (connection) => ({
  kind: connection.kind,
  protocol: Object.keys(connection.transports)[0] || null,
  transports: connection.transports,
  credentials: connection.credentials,
});

/**
 * What linking this binding into `targetConnectionId` would change.
 *
 * Read-only and secret-free: the caller learns WHICH routes move, how the two
 * backends differ (protocol / credentials / catalog), and which variant key the
 * binding would land on -- never a credential, and never a comparison the
 * browser could make itself.
 */
export async function previewBindingLink(input) {
  const { graph, binding, source, target } = await resolveLink(input);
  const routes = graph.routes.filter((route) => route.bindingId === binding.id);
  const { differences } = compareBackendEndpoints(asProfile(source), asProfile(target));
  const catalogDiffers = source.catalog.models.join(' ') !== target.catalog.models.join(' ');

  return {
    bindingId: binding.id,
    revisions: { binding: binding.revision, sourceConnection: source.revision, targetConnection: target.revision },
    affectedRouteIds: routes.map((route) => route.providerId),
    variantKey: allocateVariantKey(graph, target.id, binding),
    differences: catalogDiffers ? [...differences, 'catalog'] : differences,
    // Union by canonical identity -- linking never drops a model either side saw.
    unionModels: [...new Set([...source.catalog.models, ...target.catalog.models])],
    // Applying is an explicit second call; a preview changes nothing.
    requiresConfirmation: true,
  };
}

/**
 * The variant key `binding` may occupy on `connectionId`.
 *
 * `default` when free; otherwise a distinct labeled variant. Never a merge:
 * two harness configurations sharing one connection are both legitimate, and
 * collapsing them would discard one side's executable route ids.
 */
function allocateVariantKey(graph, connectionId, binding) {
  const taken = new Set(graph.bindings
    .filter((candidate) => candidate.connectionId === connectionId
      && candidate.harnessId === binding.harnessId
      && candidate.id !== binding.id)
    .map((candidate) => candidate.variantKey));
  return taken.has('default') ? `variant:${binding.id}` : 'default';
}

/**
 * Repoint one binding at an existing connection, then project the target's
 * connection-owned values into that binding's executable routes.
 *
 * Route ids, `activeProvider`, task pins and fallback references are untouched
 * -- only the backend those routes reach changes, which is the whole point of a
 * link. The projection runs through the pending-snapshot protocol so an
 * interrupted file write is recoverable.
 */
export function linkBinding(input) {
  return serialize(async () => {
    const { graph, binding, target } = await resolveLink(input);
    const routes = graph.routes.filter((route) => route.bindingId === binding.id);
    await relinkBinding({ bindingId: binding.id, connectionId: target.id });
    const applied = await projectRoutes(routes.map((route) => route.providerId), target);
    console.log(`🔗 Linked binding ${binding.id} to connection ${target.id} (${applied.length} routes projected)`);
    return { bindingId: binding.id, connectionId: target.id, affectedRouteIds: applied };
  });
}

/**
 * Give this binding its own copy of the connection it currently shares.
 *
 * The clone keeps the transports, credentials and catalog, so nothing about
 * execution changes and no route needs rewriting; only the graph edge moves.
 * Route ids and every mode setting are retained by construction.
 */
export function unlinkBinding(input) {
  return serialize(async () => {
    const { binding, source } = await resolveLink({ ...input, targetConnectionId: null });
    const connection = { ...source, id: randomUUID(), revision: 1 };
    await detachBindingToConnection({ bindingId: binding.id, connection });
    console.log(`🔗 Unlinked binding ${binding.id} onto its own connection ${connection.id}`);
    return { bindingId: binding.id, connectionId: connection.id };
  });
}

/**
 * Delete a connection nothing binds any more.
 *
 * Reconciliation deliberately KEEPS an emptied connection rather than
 * garbage-collecting it — a backend the user configured is not something to
 * remove because a route was temporarily deleted. This is the explicit cleanup
 * that keeps them from accumulating forever, and it is refused while a binding
 * still names the row: unlink first, so no binding is ever silently orphaned.
 */
export async function removeConnection(connectionId) {
  requireGraph();
  return serialize(async () => {
    const result = await deleteConnection(connectionId);
    if (!result.deleted) {
      throw new ServerError('Unlink the bindings that use this connection first',
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

// --- explicit management edits (#6369) ---------------------------------------
//
// The three edits a human makes to a SHARED backend, as opposed to the link and
// unlink above which change which backend a harness reaches:
//
//   1. edit the connection once and have every attached route follow it,
//   2. refresh its model catalog once for every harness on it,
//   3. choose the subset of that catalog a harness offers.
//
// All three are revision-checked against exactly what the human was looking at,
// all three run on the same serialization queue as reconciliation, and none of
// them contacts an AI provider except (3)'s explicitly requested model list.

/** Locate a row the caller named, or 404. Never a partial match on a label. */
function requireRow(rows, id, what, code) {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new ServerError(`${what} not found`, { status: 404, code });
  return row;
}

/**
 * Refuse a mutation while any of these routes is mid-projection.
 *
 * That state is precisely where the graph and `providers.json` disagree, so an
 * edit decided against it would be decided against unknown values. Same guard
 * `resolveLink` applies, applied to the connection's whole route set.
 */
function requireSettledRoutes(routes) {
  if (routes.some((route) => route.pending)) {
    throw new ServerError('This connection has an unresolved projection and cannot be changed yet',
      { status: 409, code: 'PROVIDER_GRAPH_BINDING_BLOCKED' });
  }
}

/** Every binding on a connection, and the executable routes those bindings own. */
function connectionFanout(graph, connectionId) {
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
export function updateConnectionSettings({ connectionId, expectedRevision, label, transports, credentials }) {
  return serialize(async () => {
    requireGraph();
    const graph = await readGraph();
    const connection = requireRow(graph.connections, connectionId, 'Connection', 'CONNECTION_NOT_FOUND');
    if (connection.revision !== expectedRevision) throw stale('The connection');
    const { routes } = connectionFanout(graph, connection.id);
    requireSettledRoutes(routes);

    const merged = mergeConnectionCredentials(connection.credentials, credentials);
    if (merged.rejected.length > 0) {
      throw new ServerError(
        `Send the real value or null for ${merged.rejected.join(', ')} — a redacted placeholder is not a credential`,
        { status: 400, code: 'PROVIDER_GRAPH_REDACTED_CREDENTIAL' });
    }

    const next = {
      ...connection,
      label: label ?? connection.label,
      transports: transports ?? connection.transports,
      credentials: merged.credentials,
    };
    const revision = await saveConnectionSettings(next);
    const applied = await projectRoutes(routes.map((route) => route.providerId), next);
    console.log(`🔗 Updated connection ${connection.id} (${applied.length} routes projected)`);
    return { connectionId: connection.id, revision, affectedRouteIds: applied };
  });
}

/**
 * Choose which of the shared catalog a harness offers, and rename the binding.
 *
 * Management state only — nothing here is projected into an executable record,
 * so choosing a subset can never enable a route, grant a mode's execution
 * consent, or repoint a saved selection. A pin outside the new subset stays
 * exactly where it was and simply reads as stale, which is what keeps a
 * narrowed catalog from silently repicking somebody's model.
 */
export function updateBindingSettings({ bindingId, expectedRevision, label, selectedModels }) {
  return serialize(async () => {
    requireGraph();
    const graph = await readGraph();
    const binding = requireRow(graph.bindings, bindingId, 'Binding', 'BINDING_NOT_FOUND');
    if (binding.revision !== expectedRevision) throw stale('The binding');
    requireSettledRoutes(graph.routes.filter((route) => route.bindingId === binding.id));

    const next = {
      id: binding.id,
      label: label ?? binding.label,
      selectedModels: selectedModels ?? binding.selectedModels,
    };
    const revision = await saveBindingSettings(next);
    return { bindingId: binding.id, revision, label: next.label, selectedModels: next.selectedModels };
  });
}

/**
 * Refresh the shared model catalog — ONE probe per backend, not one per route.
 *
 * `refreshProviderModelsBatch` groups the connection's routes by daemon and
 * probe shape, so a connection carrying Claude CLI, Claude TUI and OpenCode
 * routes is asked once and written once. It never throws for a per-route
 * failure, which is what lets a partial answer stay a partial answer.
 *
 * The failure rule is the one this endpoint exists for: **a failed probe keeps
 * the models the connection already knew**, with a sanitized reason attached.
 * A successful probe that returns nothing writes `known` with an empty list —
 * a backend whose last model was deleted is a real answer, not "never asked".
 * No pin, default or `activeProvider` is repicked either way.
 */
export function refreshConnectionCatalog(connectionId) {
  return serialize(async () => {
    requireGraph();
    const graph = await readGraph();
    const connection = requireRow(graph.connections, connectionId, 'Connection', 'CONNECTION_NOT_FOUND');
    const { routes } = connectionFanout(graph, connection.id);
    if (routes.length === 0) {
      throw new ServerError('This connection has no executable route to probe',
        { status: 409, code: 'PROVIDER_GRAPH_CONNECTION_UNROUTED' });
    }

    const groups = await providerService().refreshProviderModelsBatch(routes.map((route) => route.providerId));
    const failures = groups.filter((group) => group.status === 'failed');
    const refreshed = groups.some((group) => group.status === 'updated');

    // Canonical names come from the records as they are AFTER the write, so the
    // catalog and each route's alias map describe the same observation.
    const { providers } = await providerService().getAllProviders();
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const refreshedRoutes = [];
    for (const route of routes) {
      const provider = byId.get(route.providerId);
      if (!provider) continue;
      const { modelMap } = resolveRouteModels(provider);
      // Only the OBSERVED half is written back. The user's overrides stay in
      // their own column, which is what lets a hand-authored alias outlast this
      // refresh — but they still count towards the shared catalog below,
      // because a correction that no model menu offers has corrected nothing.
      await saveRouteModelMap(route.providerId, modelMap);
      refreshedRoutes.push({ ...route, modelMap });
    }
    const models = connectionCatalogModels(refreshedRoutes);

    // A failure is reported whether or not another group succeeded: a partial
    // answer is still a harness that cannot reach this backend.
    const error = failures.length > 0
      ? sanitizeCatalogError(failures[0].error, connection.credentials)
      : null;
    const catalog = nextConnectionCatalog(connection.catalog,
      refreshed ? { refreshed: true, models, error } : { refreshed: false, error });
    await saveConnectionSettings({ ...connection, catalog });

    console.log(`🔗 Refreshed connection ${connection.id} catalog: ${catalog.state}, `
      + `${catalog.models.length} models across ${groups.length} probe groups (${failures.length} failed)`);
    return { connectionId: connection.id, catalog, probedGroups: groups.length, failedGroups: failures.length };
  });
}

/**
 * Edit ONE route's mode overrides — its args, timeout, effort and model pins.
 *
 * The counterpart to `updateConnectionSettings`: that one changes a value every
 * harness on the backend shares, this one changes a value that belongs to a
 * single execution mode. Both live on this screen so a human stops bouncing
 * between a connection and three route editors to configure one backend.
 *
 * Three rules make it a genuine OVERRIDE rather than a second way to edit a
 * provider:
 *
 *   - **No sibling fan-out.** The write goes through `applyProviderPatches`,
 *     which names exactly this route. `updateProvider` would spread the edit
 *     onto the record's sibling modes, and a CLI route's `--effort` is not the
 *     TUI route's.
 *   - **No connection-owned field is reachable.** The accepted key set is the
 *     route-owned table in `providerRouteSettings.js`, so an endpoint or a
 *     credential can never be retyped here and silently escape the projection
 *     that keeps every other harness on the backend in step.
 *   - **No execution consent.** `enabled` and the transport opt-ins are absent
 *     from that table; granting them stays an explicit act on the route editor.
 *
 * The stale check is a fingerprint of the values as they are ON DISK, so an
 * edit made in `/ai/edit/:providerId` while this panel was open is caught too —
 * see `routeSettingsRevision`.
 */
export function updateRouteSettings({ providerId, expectedRevision, settings }) {
  return serialize(async () => {
    requireGraph();
    const graph = await readGraph();
    const route = graph.routes.find((candidate) => candidate.providerId === providerId);
    if (!route) throw new ServerError('Route not found', { status: 404, code: 'ROUTE_NOT_FOUND' });
    requireSettledRoutes([route]);

    const { providers } = await providerService().getAllProviders();
    const provider = providers.find((candidate) => candidate.id === providerId);
    // A graph row whose record is gone is a reconciliation removal in flight.
    // Reported as the same 404, because there is nothing left to override.
    if (!provider) throw new ServerError('Route not found', { status: 404, code: 'ROUTE_NOT_FOUND' });

    const current = routeSettingsFor(provider);
    if (routeSettingsRevision(current) !== expectedRevision) throw stale("This route's settings");

    const unsupported = unsupportedRouteSettings(route.mode, settings);
    if (unsupported.length > 0) {
      throw new ServerError(`A ${route.mode} route has no ${unsupported.join(', ')} setting`,
        { status: 400, code: 'PROVIDER_ROUTE_SETTING_UNSUPPORTED' });
    }

    // Effort is a harness capability, not free text: a route whose program takes
    // no `--effort` gets no control, and a level outside its ladder would be
    // stored and then silently dropped at spawn time.
    if (settings.effort != null) {
      const levels = effortLevelsForProvider(provider, settings.defaultModel ?? current.defaultModel ?? null);
      if (!levels || !levels.includes(settings.effort)) {
        throw new ServerError(
          levels
            ? `This route accepts effort ${levels.join(', ')}`
            : 'This route\'s harness takes no effort setting',
          { status: 400, code: 'PROVIDER_ROUTE_EFFORT_UNSUPPORTED' });
      }
    }

    const next = { ...current, ...settings };
    const applied = await writeProviderPatches({ [providerId]: settings });
    if (applied.length === 0) throw new ServerError('Route not found', { status: 404, code: 'ROUTE_NOT_FOUND' });

    // No graph row is touched on purpose. These fields are route-owned, so the
    // connection's `projected` snapshot still describes the record accurately
    // and the binding must NOT be detached — the reconcile this write triggers
    // is a documented no-op.
    console.log(`🔗 Updated route ${providerId} overrides: ${Object.keys(settings).join(', ')}`);
    return { providerId, settings: next, settingsRevision: routeSettingsRevision(next) };
  });
}

/**
 * Edit ONE route's hand-authored model aliases (#6369).
 *
 * The correction surface for `modelMap`. A refresh only ever records the
 * aliases it could VERIFY — a stored model string round-trips through the
 * harness's own adapter or it is reported unresolved rather than rewritten — so
 * a bare `example-model` on an OpenCode route that needs its `<namespace>/`
 * prefix resolves to nothing, reaches no catalog, and can be offered by no
 * model menu. Naming the pair by hand is the repair.
 *
 * The merge rule, which is the whole design decision behind this endpoint:
 *
 *   - Observed aliases and user overrides live in SEPARATE columns. A refresh
 *     rewrites the observed one wholesale and never touches the other, so an
 *     override survives every refresh and is removed only by the person who
 *     wrote it (`null` for its key).
 *   - The effective map is `{ ...observed, ...overrides }` — an override wins.
 *   - An override naming a spelling the record no longer lists is KEPT and
 *     reported stale, the same way a model pin outside the catalog is.
 *
 * The connection's catalog is re-derived here from the maps already stored,
 * because an alias that no model menu offers has fixed nothing. That is a pure
 * recompute: no backend is probed, `state` and `error` are preserved, and a
 * failed catalog keeps reading as failed.
 *
 * Stale-checked with a fingerprint of the overrides rather than a row revision,
 * for the reason `routeSettingsRevision` documents: `ai_route_bindings` has no
 * revision column, and a hash of the values catches every writer.
 */
export function updateRouteModelAliases({ providerId, expectedRevision, aliases }) {
  return serialize(async () => {
    requireGraph();
    const graph = await readGraph();
    const route = graph.routes.find((candidate) => candidate.providerId === providerId);
    if (!route) throw new ServerError('Route not found', { status: 404, code: 'ROUTE_NOT_FOUND' });
    requireSettledRoutes([route]);

    if (modelAliasRevision(route.modelAliasOverrides) !== expectedRevision) {
      throw stale("This route's model aliases");
    }

    const { aliases: overrides, removed } = applyModelAliasPatch(route.modelAliasOverrides, aliases);
    await saveRouteModelAliases(providerId, overrides);

    // Re-derive the shared catalog from every route on this backend, reading
    // the row we just wrote rather than the stale one the graph read.
    const bindingConnectionId = graph.bindings.find((binding) => binding.id === route.bindingId)?.connectionId;
    const connection = graph.connections.find((candidate) => candidate.id === bindingConnectionId);
    if (connection) {
      const { routes } = connectionFanout(graph, connection.id);
      const models = connectionCatalogModels(routes.map((entry) => (entry.providerId === providerId
        ? { ...entry, modelAliasOverrides: overrides }
        : entry)));
      await saveConnectionSettings({ ...connection, catalog: { ...connection.catalog, models } });
    }

    console.log(`🔗 Updated route ${providerId} model aliases: `
      + `${Object.keys(overrides).length} kept, ${removed.length} removed`);
    return {
      providerId,
      modelMap: effectiveModelAliases(route.modelMap, overrides),
      modelAliasOverrides: overrides,
      modelAliasRevision: modelAliasRevision(overrides),
    };
  });
}

// --- creating a backend and a harness on it (#6369) ---------------------------
//
// The two writes that ADD to the graph rather than editing it. Both are local
// I/O only: creating a backend probes nothing, and creating a harness binding
// mints DISABLED routes — configuration never generates, never launches and
// never grants execution consent (AGENTS.md "No cold-bootstrap LLM calls").

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
 * explicitly requested `POST /connections/:id/refresh-models`.
 */
export function createConnection({ kind, label, transports, credentials }) {
  return serialize(async () => {
    requireGraph();
    const blocker = connectionBlocker({ kind, transports });
    if (blocker) throw new ServerError(blocker.message, { status: 400, code: blocker.code });
    const connection = {
      id: randomUUID(),
      revision: 1,
      kind,
      label,
      transports,
      credentials: credentials || {},
      catalog: { state: 'unknown', models: [] },
    };
    await writeGraph({ connections: [connection], bindings: [], routes: [] });
    console.log(`🔗 Created provider connection ${connection.id} (${kind}, no routes yet)`);
    return { connection: toConnectionDto(connection) };
  });
}

/**
 * Create a harness binding on an existing backend, plus one executable route
 * per requested mode.
 *
 * This is the create the whole registry work was blocked on: minting a route
 * needs a per-harness COMMAND RECIPE (`PROVIDER_HARNESSES[].recipe`), because
 * the graph could previously only classify records it was handed, never
 * describe how to spawn a fresh one.
 *
 * Three guarantees, in the order they are enforced:
 *
 *   1. **Refuse before writing.** `bindingBlocker` rejects a harness with no
 *      recipe, a mode it has no support for, a backend whose transport it does
 *      not speak, and a backend missing a credential the program requires.
 *   2. **A minted route must sit on the connection it was minted for.** The
 *      record is fed straight back through `providerConnectionProfile` and
 *      checked with `routeBelongsOnConnection` — the SAME containment test
 *      reconciliation applies, so a create is judged on exactly the terms the
 *      next pass will judge it by. A route the row does not contain is refused
 *      rather than stored, because reconciliation would otherwise clone the
 *      binding onto a connection of its own on the very next pass. Containment
 *      rather than identity is what lets one route be minted on a backend that
 *      declares a second protocol for another harness (#6460).
 *   3. **Nothing is enabled.** The binding and every route arrive disabled with
 *      no model pins and no transport consent. Enabling stays an explicit act
 *      on the route editor, which is where granting execution belongs.
 *
 * The `projected` snapshot is read back off the records the toolkit actually
 * wrote, so the graph starts in agreement with `providers.json` and the
 * reconcile this write triggers is a no-op.
 */
export function createBinding({ connectionId, harnessId, modes, label }) {
  return serialize(async () => {
    requireGraph();
    const graph = await readGraph();
    const connection = requireRow(graph.connections, connectionId, 'Connection', 'CONNECTION_NOT_FOUND');

    // A backend mid-projection is precisely where the graph and providers.json
    // disagree about the endpoint and credentials this route would be built
    // from, so a new route decided against it would be built from values still
    // in dispute. Same guard every other mutation on a connection applies.
    requireSettledRoutes(connectionFanout(graph, connection.id).routes);

    const blocker = bindingBlocker({ harnessId, modes, connection });
    if (blocker) {
      const badRequest = blocker.code === 'PROVIDER_HARNESS_NOT_CREATABLE'
        || blocker.code === 'PROVIDER_HARNESS_MODE_UNSUPPORTED';
      throw new ServerError(blocker.message, { status: badRequest ? 400 : 409, code: blocker.code });
    }

    const { providers, activeProvider } = await providerService().getAllProviders();
    const taken = new Set([...providers.map((provider) => provider.id), ...graph.routes.map((route) => route.providerId)]);
    const ids = mintRouteIds({ harnessId, kind: connection.kind, modes, taken });
    const harnessLabel = harnessId ? harnessById(harnessId).label : 'Direct API';
    const name = label || `${harnessLabel} · ${connection.label || connectionKindLabel(connection.kind)}`;

    const records = modes.map((mode) => buildRouteRecord({
      harnessId,
      mode,
      providerId: ids[mode],
      name: mode === 'tui' ? `${name} TUI` : name,
      connection,
    }));
    for (const record of records) {
      if (!routeBelongsOnConnection(providerConnectionProfile(record), connection)) {
        throw new ServerError(
          `A ${harnessLabel} route cannot describe this backend as it is configured; adjust the backend's transport or credentials first`,
          { status: 409, code: 'PROVIDER_GRAPH_CONNECTION_INCOMPATIBLE' });
      }
    }

    const bindingId = randomUUID();
    const binding = {
      id: bindingId,
      revision: 1,
      connectionId: connection.id,
      harnessId,
      // `default` when this harness is not already on the backend, a labeled
      // variant otherwise — two configurations of one program on one backend
      // are both legitimate and must not collapse into each other.
      variantKey: allocateVariantKey(graph, connection.id, { id: bindingId, harnessId }),
      label: name,
      enabled: false,
      selectedModels: [],
    };

    // If a create fails part-way, the records that landed simply have no graph
    // row yet — the next reconciliation pass imports them as their own fragment
    // rather than losing them. That is the same path a legacy write takes.
    await duringProviderWrite(async () => {
      for (const record of records) await providerService().createProvider(record);
    });

    const { providers: written, activeProvider: activeAfter } = await providerService().getAllProviders();
    const byId = new Map(written.map((provider) => [provider.id, provider]));
    const routes = modes
      .filter((mode) => byId.has(ids[mode]))
      .map((mode) => ({
        providerId: ids[mode],
        bindingId: binding.id,
        mode,
        modelMap: {},
        modelAliasOverrides: {},
        projected: connectionOwnedSnapshot(byId.get(ids[mode])),
        pending: null,
        pendingRevision: null,
      }));
    await writeGraph({ connections: [], bindings: [binding], routes });

    console.log(`🔗 Created ${harnessLabel} binding ${binding.id} on connection ${connection.id}: `
      + `${routes.map((route) => route.providerId).join(', ')} (disabled)`);
    return {
      connectionId: connection.id,
      bindingId: binding.id,
      harnessId,
      variantKey: binding.variantKey,
      label: binding.label,
      enabled: false,
      routeIds: routes.map((route) => route.providerId),
      // Reported rather than hidden: the toolkit adopts the first route as the
      // system default on an install that has none, and a disabled route being
      // named the default grants no execution — but the caller should still be
      // told its default moved.
      activeProvider: activeAfter ?? null,
      activeProviderChanged: (activeAfter ?? null) !== (activeProvider ?? null),
    };
  });
}
