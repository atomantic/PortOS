import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { serviceDefinitionById } from '../../lib/serviceDefinitions.js';
import {
  MAX_POOL_ENTRIES,
  PRIMARY_CREDENTIAL_ID,
  connectionOrigin,
  definitionDefaultOrigins,
  isPoolEnvVarName,
  readStoredPool,
  writeStoredPool,
} from '../../lib/provider/credentialPool.js';
import { findConnectionByRef, requireProviderGraph, serializeProviderGraph } from './providerGraph.js';
import { readGraph, saveConnectionSettings } from './providerGraphStore.js';
import {
  describeConnectionPool,
  forgetConnectionPoolCredential,
  invalidateCredentialPoolCache,
  poolForConnection,
  resetConnectionPoolCooldowns,
} from './credentialPoolRuntime.js';

/**
 * Credential-pool MANAGEMENT on a service instance (#17384): list, add, edit,
 * reorder and remove the extra keys of one `ai_connections` row, choose its
 * strategy, and clear its cooldowns. The selection and cooldown rules live in
 * `lib/provider/credentialPool.js`; the in-memory ledger in
 * `credentialPoolRuntime.js`.
 *
 * Every write runs on the provider graph's serialization queue and reads the
 * row fresh, so two overlapping edits cannot drop each other's key. Responses
 * are display-safe: a masked fingerprint, never a key value. Nothing here
 * contacts a provider.
 *
 * Env entries are REFERENCES (`envVar`), resolved from the process at request
 * time and never copied into the row, and may only name the definition's own
 * credential variables or their numbered siblings.
 */

const fail = (message, status, code) => new ServerError(message, { status, code });

function requirePoolableService(graph, ref) {
  const connection = findConnectionByRef(graph, ref);
  if (!connection) throw fail('Service not found', 404, 'SERVICE_NOT_FOUND');
  const definition = connection.definitionId ? serviceDefinitionById(connection.definitionId) : null;
  if (!definition) throw fail('This service has no definition this build knows', 409, 'SERVICE_DEFINITION_UNKNOWN');
  const via = connection.credentialVia ?? 'stored';
  if (via !== 'stored' && via !== 'env') {
    throw fail('Only a service that runs on an API key can pool keys; this one signs in or is supplied at launch',
      409, 'CREDENTIAL_POOL_UNSUPPORTED');
  }
  return { connection, definition };
}

/** The origin a newly stored key binds to: the row's own endpoint, else the definition's shipped one. */
function bindingOrigin(connection, definition) {
  return connectionOrigin(connection) ?? [...definitionDefaultOrigins(definition)][0] ?? null;
}

const present = (connection) => ({
  service: connection.slug ?? connection.id,
  revision: connection.revision,
  ...describeConnectionPool(connection),
});

/** One service's pool as `/ai/services` renders it — a read-only peek. */
export async function getCredentialPool(ref) {
  requireProviderGraph();
  const graph = await readGraph();
  const { connection } = requirePoolableService(graph, ref);
  return present(connection);
}

/**
 * Read the row, apply `mutate(pool, context)` to its stored pool, write it
 * back. `mutate` returns nothing; it edits the pool object in place or throws.
 */
function editPool(ref, mutate) {
  return serializeProviderGraph(async () => {
    requireProviderGraph();
    const graph = await readGraph();
    const { connection, definition } = requirePoolableService(graph, ref);
    const pool = readStoredPool(connection.credentials);
    const resolved = poolForConnection(connection);
    await mutate(pool, { connection, definition, resolved });
    const credentials = writeStoredPool(connection.credentials, pool);
    const revision = await saveConnectionSettings({ ...connection, credentials });
    invalidateCredentialPoolCache();
    return present({ ...connection, credentials, revision: revision ?? connection.revision });
  });
}

/**
 * Add one key: a stored value (bound to the service's current origin) or a
 * reference to an env variable.
 *
 * @param {string} ref - slug or id
 * @param {{label?: string, apiKey?: string, envVar?: string, enabled?: boolean}} input
 */
export function addPoolCredential(ref, { label, apiKey, envVar, enabled = true }) {
  return editPool(ref, (pool, { connection, definition, resolved }) => {
    if (pool.entries.length >= MAX_POOL_ENTRIES) throw fail(`A pool holds at most ${MAX_POOL_ENTRIES} keys`, 409, 'CREDENTIAL_POOL_FULL');
    const id = `key-${randomUUID()}`;
    const addedAt = new Date().toISOString();
    if (apiKey) {
      if (resolved?.entries.some((entry) => entry.apiKey === apiKey)) {
        throw fail('That key is already in this service\'s pool', 409, 'CREDENTIAL_POOL_DUPLICATE');
      }
      const origin = bindingOrigin(connection, definition);
      if (!origin) throw fail('This service declares no endpoint to bind a key to', 409, 'CREDENTIAL_POOL_NO_ORIGIN');
      pool.entries.push({ id, label: label || 'Pool key', source: 'stored', apiKey, origin, enabled, addedAt });
      return;
    }
    if (!isPoolEnvVarName(envVar, definition)) {
      throw fail(`An env pool key must name ${definition.credential.envVars.join(' / ') || 'a credential variable'} or a numbered sibling (_2, _3, …)`,
        400, 'CREDENTIAL_POOL_ENV_NOT_ALLOWED');
    }
    if (resolved?.entries.some((entry) => entry.envVar === envVar)) {
      throw fail(`${envVar} is already in this service's pool`, 409, 'CREDENTIAL_POOL_DUPLICATE');
    }
    pool.entries.push({ id, label: label || envVar, source: 'env', envVar, enabled, addedAt });
  });
}

const requireStoredEntry = (pool, credentialId) => {
  const entry = pool.entries.find((candidate) => candidate.id === credentialId);
  if (!entry) throw fail('No such pool key', 404, 'CREDENTIAL_POOL_KEY_NOT_FOUND');
  return entry;
};

const autoEnvName = (credentialId) => (credentialId.startsWith('env:') ? credentialId.slice(4) : null);

/**
 * Edit one key's label or enablement, or re-bind a stored key to the
 * service's CURRENT origin (the explicit step after an endpoint change). An
 * auto-discovered env sibling only switches on/off; the primary key is edited
 * on the service itself.
 */
export function updatePoolCredential(ref, credentialId, { label, enabled, rebindOrigin = false }) {
  return editPool(ref, (pool, { connection, definition, resolved }) => {
    if (credentialId === PRIMARY_CREDENTIAL_ID) {
      throw fail('The primary key is edited on the service itself', 409, 'CREDENTIAL_POOL_PRIMARY_IMMUTABLE');
    }
    const envName = autoEnvName(credentialId);
    if (envName) {
      if (!resolved?.entries.some((entry) => entry.id === credentialId)) throw fail('No such pool key', 404, 'CREDENTIAL_POOL_KEY_NOT_FOUND');
      if (enabled === false && !pool.disabledEnv.includes(envName)) pool.disabledEnv.push(envName);
      if (enabled === true) pool.disabledEnv = pool.disabledEnv.filter((name) => name !== envName);
      return;
    }
    const entry = requireStoredEntry(pool, credentialId);
    if (label !== undefined) entry.label = label;
    if (enabled !== undefined) entry.enabled = enabled;
    if (rebindOrigin) {
      if (entry.source !== 'stored') throw fail('Only a stored key is bound to an origin', 409, 'CREDENTIAL_POOL_NOT_BOUND');
      const origin = bindingOrigin(connection, definition);
      if (!origin) throw fail('This service declares no endpoint to bind a key to', 409, 'CREDENTIAL_POOL_NO_ORIGIN');
      entry.origin = origin;
    }
  });
}

/** Remove one stored key or env reference, with its cooldown state. */
export async function removePoolCredential(ref, credentialId) {
  const result = await editPool(ref, (pool) => {
    if (credentialId === PRIMARY_CREDENTIAL_ID || autoEnvName(credentialId)) {
      throw fail('Only a key added to the pool can be removed; switch a discovered one off instead', 409, 'CREDENTIAL_POOL_NOT_REMOVABLE');
    }
    requireStoredEntry(pool, credentialId);
    pool.entries = pool.entries.filter((entry) => entry.id !== credentialId);
    pool.order = pool.order.filter((id) => id !== credentialId);
  });
  forgetConnectionPoolCredential(result.service, credentialId);
  return result;
}

/**
 * Set the strategy and/or the priority order. `order` names every credential
 * id the caller wants ranked; ids it omits keep their natural place after it,
 * and an id the pool does not hold is refused rather than silently dropped.
 */
export function updatePoolSettings(ref, { strategy, order }) {
  return editPool(ref, (pool, { resolved }) => {
    if (strategy !== undefined) pool.strategy = strategy;
    if (order !== undefined) {
      const known = new Set(resolved?.entries.map((entry) => entry.id) ?? []);
      const unknown = order.filter((id) => !known.has(id));
      if (unknown.length > 0) throw fail(`Not in this pool: ${unknown.join(', ')}`, 400, 'CREDENTIAL_POOL_ORDER_UNKNOWN');
      pool.order = [...new Set(order)];
    }
  });
}

/** Clear cooldowns (one key, or all of them). Ledger only: the row is not written. */
export async function resetPoolCredentialCooldowns(ref, { credentialId = null } = {}) {
  requireProviderGraph();
  const graph = await readGraph();
  const { connection } = requirePoolableService(graph, ref);
  const slug = connection.slug ?? connection.id;
  resetConnectionPoolCooldowns(slug, credentialId);
  console.log(`🔑 Credential pool ${slug}: cooldowns reset (${credentialId ?? 'all keys'})`);
  return present(connection);
}
