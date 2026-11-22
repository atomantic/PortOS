import { serviceDefinitionById } from '../../lib/serviceDefinitions.js';
import { instanceApiKeyFor } from '../../lib/provider/providerServiceInstances.js';
import {
  createCredentialSession,
  createPoolLedger,
  forgetPoolCredential,
  isModelScopedPool,
  peekPoolStatus,
  resetPoolCooldowns,
  resolvePoolEntries,
  usablePoolEntries,
} from '../../lib/provider/credentialPool.js';
import { createSingleFlight } from '../../lib/singleFlight.js';


/**
 * The live half of credential pools (#17384): the process-wide cooldown ledger
 * and the per-request session every API execution path opens before it sends.
 *
 * Machine-local and in memory only: a cooldown is a fact about this process's
 * recent traffic, like a provider bench, and a restart forgets it. The pool's
 * CONFIGURATION is on the `ai_connections` row (`credentials.credentialPool`),
 * which never federates.
 *
 * A session opens only when the request's provider record IS a service
 * instance's route (`serviceId` names the row), still runs under that row's
 * primary key (a record whose key was overridden runs on its own key, never a
 * pool key it was not given), and the pool has two or more usable keys. In
 * every other case `openCredentialSession` answers `null` and the caller sends
 * exactly what it sent before pools existed.
 */

/** Same short TTL as the composite resolver: a failure storm re-reads per request, edits land next tick. */
const GRAPH_SNAPSHOT_TTL_MS = 1000;
let graphSnapshot = null;
let graphSnapshotAt = -Infinity;
const graphReads = createSingleFlight();
let ledger = createPoolLedger();

async function graphWithinTtl() {
  if (graphSnapshot && Date.now() - graphSnapshotAt < GRAPH_SNAPSHOT_TTL_MS) return graphSnapshot;
  return graphReads.run('graph', async () => {
    // Deferred: the store pulls the DB client, which a run path that never
    // meets a pooled service must not pay for (server/AGENTS.md "Import scoping").
    const { readGraph } = await import('./providerGraphStore.js');
    graphSnapshot = await readGraph();
    graphSnapshotAt = Date.now();
    return graphSnapshot;
  });
}

/** Drop the cached graph read — called after a pool edit so the next request sees it. */
export function invalidateCredentialPoolCache() {
  graphSnapshot = null;
  graphSnapshotAt = -Infinity;
}

/** Test seam: a fresh ledger and no cached graph. */
export function resetCredentialPoolRuntime() {
  ledger = createPoolLedger();
  invalidateCredentialPoolCache();
}

/**
 * The instance's resolved pool for one target endpoint, or `null` when the row
 * has no definition this build knows.
 *
 * @param {object} connection - an `ai_connections` row
 * @param {{env?: object, endpoint?: string|null}} [context]
 */
export function poolForConnection(connection, { env = process.env, endpoint = null } = {}) {
  const definition = connection?.definitionId ? serviceDefinitionById(connection.definitionId) : null;
  if (!definition) return null;
  const primaryKey = instanceApiKeyFor(connection, definition, env);
  return { definition, primaryKey, ...resolvePoolEntries(connection, definition, { primaryKey, env, endpoint }) };
}

/**
 * Open a rotation session for one request, or `null` (send as before).
 *
 * Never throws: a graph that cannot be read is "no pool", because a pool is an
 * availability improvement and must never be the reason a run fails.
 *
 * @param {object} provider - the executable record about to be sent
 * @param {string|null} model
 * @param {{graph?: object, env?: object, clock?: () => number, delay?: Function}} [deps] - test seams
 */
export async function openCredentialSession(provider, model, deps = {}) {
  const slug = typeof provider?.serviceId === 'string' ? provider.serviceId : null;
  if (!slug || typeof provider.apiKey !== 'string' || provider.apiKey === '') return null;
  const graph = deps.graph ?? await graphWithinTtl().catch((err) => {
    console.log(`🔑 Credential pool lookup skipped for ${slug}: ${err.message}`);
    return null;
  });
  const connection = graph?.connections?.find((candidate) => candidate.slug === slug) ?? null;
  if (!connection || connection.enabled === false) return null;
  const pool = poolForConnection(connection, { env: deps.env ?? process.env, endpoint: provider.endpoint });
  if (!pool || pool.primaryKey !== provider.apiKey || usablePoolEntries(pool.entries).length < 2) return null;
  return createCredentialSession({
    entries: pool.entries,
    strategy: pool.strategy,
    slug,
    ledger,
    model: model || provider.defaultModel || null,
    modelScoped: isModelScopedPool({ definitionId: pool.definition.id, endpoint: provider.endpoint }),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.delay ? { delay: deps.delay } : {}),
    log: (line) => console.log(line),
  });
}

/**
 * The display-safe pool status of a row — a PEEK: it reads the ledger and
 * never rotates, benches, or expires anything.
 */
export function describeConnectionPool(connection, { env = process.env, now = Date.now() } = {}) {
  const pool = poolForConnection(connection, { env });
  if (!pool) return { strategy: null, entries: [], active: false };
  const slug = connection.slug ?? connection.id;
  return {
    strategy: pool.strategy,
    entries: peekPoolStatus(pool.entries, { ledger, slug, now }),
    // Rotation runs only with two or more keys a request could use.
    active: usablePoolEntries(pool.entries).length >= 2,
  };
}

/** Clear cooldowns on one credential, or every credential of the service. */
export function resetConnectionPoolCooldowns(slug, credentialId = null) {
  resetPoolCooldowns(ledger, slug, credentialId);
}

/** Forget a removed credential's ledger state. */
export function forgetConnectionPoolCredential(slug, credentialId) {
  forgetPoolCredential(ledger, slug, credentialId);
}
