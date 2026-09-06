import { randomUUID } from 'node:crypto';
import { ServerError } from '../lib/errorHandler.js';
import { compareBackendEndpoints, withConnectionOwnedFields } from '../lib/providerConnections.js';
import {
  connectionOwnedSnapshot,
  planGraphReconciliation,
  reconciliationIsNoop,
  toManagementGraphDto,
} from '../lib/providerGraphRecords.js';
import { requireToolkit } from '../lib/aiToolkitState.js';
import {
  acknowledgeProjection,
  applyReconciliation,
  commitPendingProjection,
  deleteConnection,
  detachBindingToConnection,
  readGraph,
  relinkBinding,
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

/** The sanitized `GET /api/providers/management` body. */
export async function getManagementGraph() {
  requireGraph();
  const [graph, data] = await Promise.all([readGraph(), providerService().getAllProviders()]);
  return toManagementGraphDto({ ...graph, activeProvider: data.activeProvider });
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
    .map((providerId) => ({ providerId, owned: ownedFromConnection(byId.get(providerId), connection) }));
  if (projections.length === 0) return [];

  await commitPendingProjection(projections);
  reconciling = true;
  const written = await providerService().applyProviderPatches(Object.fromEntries(
    projections.map(({ providerId, owned }) => [providerId, projectionPatch(byId.get(providerId), owned)]),
  )).finally(() => { reconciling = false; });
  await acknowledgeProjection(written);
  return written;
}

/**
 * The connection-owned snapshot a route should carry once bound to
 * `connection`: the record's own owned KEY SET (so the split stays lossless for
 * this record's shape) filled with the connection's values.
 */
function ownedFromConnection(provider, connection) {
  const owned = connectionOwnedSnapshot(provider);
  const baseUrl = Object.values(connection.transports)[0]?.baseUrl ?? null;
  const fields = { ...owned.fields };
  if (Object.hasOwn(fields, 'endpoint') && baseUrl !== null) fields.endpoint = baseUrl;
  if (Object.hasOwn(fields, 'apiKey')) fields.apiKey = connection.credentials.apiKey ?? fields.apiKey;
  const envVars = { ...owned.envVars };
  for (const name of Object.keys(envVars)) {
    if (Object.hasOwn(connection.credentials, name)) {
      envVars[name] = connection.credentials[name];
      continue;
    }
    // `ANTHROPIC_BASE_URL` names the anthropic transport, not merely "a URL":
    // a connection that speaks several protocols has a different base URL for
    // each, and picking the first would point the harness at the wrong port.
    const protocol = /_BASE_URL$/.test(name) ? name.replace(/_BASE_URL$/, '').toLowerCase() : null;
    const url = protocol ? connection.transports[protocol]?.baseUrl ?? baseUrl : null;
    if (url) envVars[name] = url;
  }
  return { fields, envVars, hasEnvVars: owned.hasEnvVars };
}
