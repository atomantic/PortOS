/**
 * Move the CoS agent records into PostgreSQL (#12738).
 *
 * Until now every agent record lived in `data/cos/state.json`'s `agents` map,
 * and every status or output update rewrote the whole file. They now live in
 * `cos_agents`, one row per agent, holding the record's exact JSON text. This
 * migration is the only code that still reads the map.
 *
 * Input-derived, so it ships no `data.reference` seed and gates on its INPUT
 * (the map), never on the absence of its output. The map is the source of truth
 * until 021 retires it, so an existing row with the same id is replaced. Every
 * record is verified byte for byte (`agent::text` against the source
 * serialization) before commit; any mismatch throws, the transaction rolls back,
 * and boot stops to retry on the next start rather than serve a half-migrated
 * agent set. The store version is bumped so a cache planned before this import
 * (a database restore replaying migrations at runtime) cannot overwrite it.
 */
import { readCosStateAgents } from './_cosStateAgents.js';

const BATCH = 100;

// Frozen copy of the projection columns lib/cosAgentRows.js derives.
function rowColumns(agent) {
  const timestamp = (value) => {
    const ms = typeof value === 'string' || typeof value === 'number' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  return {
    taskId: typeof agent?.taskId === 'string' ? agent.taskId : null,
    status: typeof agent?.status === 'string' ? agent.status : 'unknown',
    startedAt: timestamp(agent?.startedAt),
    completedAt: timestamp(agent?.completedAt),
    pid: Number.isSafeInteger(agent?.pid) && agent.pid > 0 && agent.pid <= 2_147_483_647 ? agent.pid : null,
  };
}

export async function up(client) {
  const { agents } = await readCosStateAgents();
  if (!agents) return;
  // An undefined entry cannot occur in parsed JSON; every entry is a record to keep.
  const rows = Object.entries(agents).map(([id, agent]) => ({ id, body: JSON.stringify(agent), ...rowColumns(agent) }));
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    await client.query(
      `INSERT INTO cos_agents (agent_id, task_id, status, started_at, completed_at, pid, agent)
       SELECT u.agent_id, u.task_id, u.status, u.started_at, u.completed_at, u.pid, u.agent::json
       FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::int[], $7::text[])
         WITH ORDINALITY AS u(agent_id, task_id, status, started_at, completed_at, pid, agent, ord)
       ORDER BY u.ord
       ON CONFLICT (agent_id) DO UPDATE SET task_id = EXCLUDED.task_id, status = EXCLUDED.status,
         started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at, pid = EXCLUDED.pid, agent = EXCLUDED.agent`,
      [batch.map((r) => r.id), batch.map((r) => r.taskId), batch.map((r) => r.status), batch.map((r) => r.startedAt),
        batch.map((r) => r.completedAt), batch.map((r) => r.pid), batch.map((r) => r.body)],
    );
  }
  const { rows: stored } = await client.query(
    'SELECT agent_id, agent::text AS body FROM cos_agents WHERE agent_id = ANY($1::text[])',
    [rows.map((r) => r.id)],
  );
  const byId = new Map(stored.map((row) => [row.agent_id, row.body]));
  const mismatched = rows.filter((r) => byId.get(r.id) !== r.body).length;
  if (mismatched > 0) {
    throw new Error(`CoS agent import verification failed: ${mismatched} of ${rows.length} records are missing or differ`);
  }
  await client.query(
    `INSERT INTO cos_agent_store (id, version) VALUES (1, 1)
     ON CONFLICT (id) DO UPDATE SET version = cos_agent_store.version + 1`,
  );
  console.log(`🗄️ CoS agents: imported ${rows.length} agent record(s) from state.json`);
}
