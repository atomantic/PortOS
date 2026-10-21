/**
 * PostgreSQL backend of the CoS task queues, against the shared contract in
 * _cosTaskRepositoryContract.js. Runs via `npm run test:db` (→ `portos_test`)
 * ONLY; skips cleanly when no database is reachable.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { __makePgCosTaskBackend } from './cosTaskRepository.js';
import { __runCosTaskRepositoryContract } from './_cosTaskRepositoryContract.js';
import { planListSave } from '../lib/cosTaskRows.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('services/cosTaskRepository.db.test', health.connected, 'disposable PostgreSQL unavailable');

afterAll(async () => {
  if (runDb) { await query('DELETE FROM cos_tasks'); await query('DELETE FROM cos_task_lists'); }
  if (health.connected) await close();
});

describe.skipIf(!runDb)('cos_tasks repository on PostgreSQL', () => {
  __runCosTaskRepositoryContract({
    name: 'postgres',
    makeBackend: async () => {
      await query('DELETE FROM cos_tasks');
      await query('DELETE FROM cos_task_lists');
      return __makePgCosTaskBackend({ query, withTransaction });
    },
  });
});

// PostgreSQL refuses a lone surrogate in jsonb and NUL in jsonb/text; the file
// stores these queues came from accepted both (#12815).
describe.skipIf(!runDb)('cos_tasks repository text PostgreSQL would refuse', () => {
  const task = (n, description) => ({
    id: `task-example-${n}`, status: 'pending', priority: 'MEDIUM', priorityValue: 2, description,
    approvalRequired: false, autoApproved: true, metadata: {},
  });

  it('repairs a split emoji and a NUL to U+FFFD instead of failing the save', async () => {
    await query('DELETE FROM cos_tasks');
    await query('DELETE FROM cos_task_lists');
    const backend = __makePgCosTaskBackend({ query, withTransaction });
    // The cut askPromote makes: 279 characters, then half of an emoji's surrogate pair.
    const split = `${'a'.repeat(279)}${'😀'.slice(0, 1)}`;
    const next = [task(1, split), task(2, 'before\0after')];
    const { rows } = await backend.loadWorkingSet('user');
    const plan = planListSave({ previous: rows, next, source: 'user' });
    await backend.apply('user', { upserts: plan.upserts, deletes: plan.deletes });

    const saved = Object.fromEntries((await backend.loadWorkingSet('user')).rows.map((row) => [row.task.id, row.task]));
    expect(saved['task-example-1'].description).toBe(`${'a'.repeat(279)}\uFFFD`);
    expect(saved['task-example-2'].description).toBe('before\uFFFDafter');
    const { rows: [column] } = await query('SELECT description FROM cos_tasks WHERE task_id = $1', ['task-example-2']);
    expect(column.description).toBe('before\uFFFDafter');
  });
});
