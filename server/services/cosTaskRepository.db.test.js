/**
 * PostgreSQL backend of the CoS task queues, against the shared contract in
 * _cosTaskRepositoryContract.js. Runs via `npm run test:db` (→ `portos_test`)
 * ONLY; skips cleanly when no database is reachable.
 */
import { afterAll, describe } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { __makePgCosTaskBackend } from './cosTaskRepository.js';
import { __runCosTaskRepositoryContract } from './_cosTaskRepositoryContract.js';

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
