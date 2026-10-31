/**
 * Persistence for the CoS agent working set (`cos_agents`): one row per agent
 * record that used to live in `data/cos/state.json`'s `agents` map.
 *
 * PostgreSQL is authoritative. The in-memory backend exists only for the
 * documented development/test escape hatch (it persists to `data/cos-agents.json`
 * outside the test runner so a database-less dev run survives a restart).
 *
 * The working set is what state.json held: running agents plus finished ones
 * `archiveStaleAgents()` has not yet moved to `data/cos/agents/<date>/`. A write
 * carries only the changed rows (lib/cosAgentRows.js `planAgentSave`) and names
 * the store version it was planned against; a write planned against an older
 * version is refused with `COS_AGENTS_STALE`, so a stale cache (for example
 * after a database restore) can never delete or overwrite rows it did not see.
 */

import { join } from 'node:path';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createPgFileFacade, resolvePgBackend, POSTGRES_SETUP_HINT } from '../lib/pgFileFacade.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { agentRowColumns, planAgentSave } from '../lib/cosAgentRows.js';

// Bounds one statement's parameter payload (a record with its output is up to ~100 KB).
const UPSERT_BATCH = 100;
const agentsFile = () => join(PATHS.data, 'cos-agents.json');

const staleError = (expected, actual) => Object.assign(
  new Error(`CoS agent records changed underneath this write (planned against version ${expected}, store is at ${actual}). Read the current state before retrying.`),
  { code: 'COS_AGENTS_STALE', status: 409 },
);

function makePgBackend(db) {
  const { query, withTransaction } = db;
  return {
    name: 'postgres',
    async loadAgents() {
      // One statement, so the version and the rows come from the same snapshot.
      const { rows } = await query(
        `SELECT COALESCE((SELECT version FROM cos_agent_store WHERE id = 1), 0) AS version, a.agent_id, a.agent::text AS body
         FROM (SELECT 1) AS one LEFT JOIN cos_agents a ON true
         ORDER BY a.seq`,
      );
      return {
        version: Number(rows[0]?.version ?? 0),
        rows: rows.filter((row) => row.agent_id !== null).map((row) => ({ id: row.agent_id, body: row.body })),
      };
    },
    async apply({ upserts, deletes }, expectedVersion) {
      return withTransaction(async (client) => {
        await client.query('INSERT INTO cos_agent_store (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING');
        const { rows: locked } = await client.query('SELECT version FROM cos_agent_store WHERE id = 1 FOR UPDATE');
        const current = Number(locked[0].version);
        if (current !== expectedVersion) throw staleError(expectedVersion, current);
        if (deletes.length > 0) await client.query('DELETE FROM cos_agents WHERE agent_id = ANY($1::text[])', [deletes]);
        for (let start = 0; start < upserts.length; start += UPSERT_BATCH) {
          const batch = upserts.slice(start, start + UPSERT_BATCH).map(({ id, body, agent }) => ({ id, body, ...agentRowColumns(agent) }));
          await client.query(
            `INSERT INTO cos_agents (agent_id, task_id, status, started_at, completed_at, pid, agent)
             SELECT u.agent_id, u.task_id, u.status, u.started_at, u.completed_at, u.pid, u.agent::json
             FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::int[], $7::text[])
               AS u(agent_id, task_id, status, started_at, completed_at, pid, agent)
             ON CONFLICT (agent_id) DO UPDATE SET task_id = EXCLUDED.task_id, status = EXCLUDED.status,
               started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at, pid = EXCLUDED.pid, agent = EXCLUDED.agent`,
            [batch.map((r) => r.id), batch.map((r) => r.taskId), batch.map((r) => r.status), batch.map((r) => r.startedAt),
              batch.map((r) => r.completedAt), batch.map((r) => r.pid), batch.map((r) => r.body)],
          );
        }
        const { rows } = await client.query('UPDATE cos_agent_store SET version = version + 1 WHERE id = 1 RETURNING version');
        return Number(rows[0].version);
      });
    },
    async getAgent(agentId) {
      const { rows } = await query('SELECT agent::text AS body FROM cos_agents WHERE agent_id = $1', [agentId]);
      return rows[0] ? JSON.parse(rows[0].body) : null;
    },
    async listStatuses() {
      const { rows } = await query('SELECT agent_id, status FROM cos_agents ORDER BY seq');
      return rows.map((row) => ({ id: row.agent_id, status: row.status }));
    },
  };
}

async function makeMemoryBackend({ persist }) {
  // id -> exact JSON text, in insertion order (a Map keeps it, like `seq`).
  const bodies = new Map();
  let version = 0;
  if (persist) {
    const { ok, value: saved } = await readJSONFileStrict(agentsFile(), null, { logError: false });
    // Never start empty over an unreadable file: the next write would replace it.
    if (!ok) throw new Error(`Unreadable ${agentsFile()} — repair or remove it before starting the dev file backend`);
    for (const row of saved?.rows ?? []) bodies.set(row.id, row.body);
    version = saved?.version ?? 0;
  }
  const flush = () => (persist ? atomicWrite(agentsFile(), { version, rows: [...bodies].map(([id, body]) => ({ id, body })) }) : Promise.resolve());

  return {
    name: 'memory',
    async loadAgents() { return { version, rows: [...bodies].map(([id, body]) => ({ id, body })) }; },
    async apply({ upserts, deletes }, expectedVersion) {
      if (version !== expectedVersion) throw staleError(expectedVersion, version);
      for (const id of deletes) bodies.delete(id);
      for (const { id, body } of upserts) bodies.set(id, body);
      version += 1;
      await flush();
      return version;
    },
    async getAgent(agentId) { return bodies.has(agentId) ? JSON.parse(bodies.get(agentId)) : null; },
    async listStatuses() {
      return [...bodies].map(([id, body]) => ({ id, status: agentRowColumns(JSON.parse(body)).status }));
    },
  };
}

const backendFacade = createPgFileFacade({
  makeFile: () => makeMemoryBackend({ persist: !isTestRunner() }),
  makePg: () => resolvePgBackend({
    requirement: `The CoS agent records require PostgreSQL — ${POSTGRES_SETUP_HINT}`,
    loadDb: () => import('../lib/db.js'),
    makePg: makePgBackend,
  }),
});
const backend = async () => backendFacade.getBackend();

/** `{ version, rows: [{ id, body }] }` — the working set in insertion order, each record as its stored JSON text. */
export async function loadAgentRows() { return (await backend()).loadAgents(); }

/**
 * Persist a save plan (`planAgentSave`'s upserts/deletes) in one transaction,
 * provided the store is still at `expectedVersion`; returns the new version.
 * Throws `COS_AGENTS_STALE` (status 409) otherwise.
 */
export async function applyAgentSave(plan, expectedVersion) { return (await backend()).apply(plan, expectedVersion); }

/** One stored agent record, or null. Reads the store, never a cache. */
export async function getStoredAgent(agentId) { return (await backend()).getAgent(agentId); }

/** `[{ id, status }]` for every stored agent, without record bodies. */
export async function listStoredAgentStatuses() { return (await backend()).listStatuses(); }

/** Test seam: replace the stored working set with `agents` (an id → record map). */
export async function __seedCosAgents(agents) {
  const selected = await backend();
  const { version, rows } = await selected.loadAgents();
  const plan = planAgentSave({ persisted: new Map(rows.map((row) => [row.id, row.body])), next: agents });
  return selected.apply(plan, version);
}

/** Test seam: drop the selected backend (and, for the in-memory one, everything in it). */
export function __resetCosAgentRepository() { backendFacade.reset(); }

/** Test seam: the PostgreSQL backend over a `{ query, withTransaction }` handle, for the DB suite. */
export const __makePgCosAgentBackend = makePgBackend;
/** Test seam: a fresh in-memory backend; it touches disk only with `persist: true`. */
export const __makeMemoryCosAgentBackend = ({ persist = false } = {}) => makeMemoryBackend({ persist });
