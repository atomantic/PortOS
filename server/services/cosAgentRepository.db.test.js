/**
 * PostgreSQL backend of the CoS agent records, against the shared contract in
 * _cosAgentRepositoryContract.js. Runs via `npm run test:db` (→ `portos_test`)
 * ONLY; skips cleanly when no database is reachable.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { planAgentSave } from '../lib/cosAgentRows.js';
import { __makePgCosAgentBackend } from './cosAgentRepository.js';
import { __runCosAgentRepositoryContract } from './_cosAgentRepositoryContract.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('services/cosAgentRepository.db.test', health.connected, 'disposable PostgreSQL unavailable');

const reset = async () => {
  await query('DELETE FROM cos_agents');
  await query('DELETE FROM cos_agent_store');
};

afterAll(async () => {
  if (runDb) await reset();
  if (health.connected) await close();
});

describe.skipIf(!runDb)('cos_agents repository on PostgreSQL', () => {
  __runCosAgentRepositoryContract({
    name: 'postgres',
    makeBackend: async () => {
      await reset();
      return __makePgCosAgentBackend({ query, withTransaction });
    },
  });

  it('rewrites only the changed row: untouched rows keep their tuple version', async () => {
    await reset();
    const backend = __makePgCosAgentBackend({ query, withTransaction });
    const agents = Object.fromEntries(Array.from({ length: 5 }, (_, n) => [`agent-example-${n}`, { id: `agent-example-${n}`, status: 'running' }]));
    const first = planAgentSave({ persisted: new Map(), next: agents });
    const version = await backend.apply(first, 0);
    const xmins = async () => Object.fromEntries((await query('SELECT agent_id, xmin::text AS xmin FROM cos_agents')).rows.map((row) => [row.agent_id, row.xmin]));
    const before = await xmins();
    const second = planAgentSave({ persisted: first.persisted, next: { ...agents, 'agent-example-2': { id: 'agent-example-2', status: 'completed' } } });
    await backend.apply(second, version);
    const after = await xmins();
    const changed = Object.keys(after).filter((agentId) => after[agentId] !== before[agentId]);
    expect(changed).toEqual(['agent-example-2']);
    const { rows } = await query("SELECT status, task_id FROM cos_agents WHERE agent_id = 'agent-example-2'");
    expect(rows[0]).toEqual({ status: 'completed', task_id: null });
  });
});
