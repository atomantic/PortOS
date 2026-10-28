import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

// Exercise the production adapter through its public persistence boundary.
vi.mock('../lib/pgFileFacade.js', async original => {
  const actual = await original();
  return { ...actual, createPgFileFacade: options => actual.createPgFileFacade({ ...options, isFile: () => false }) };
});
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('services/releaseSynchronizationStore.db.test', health.connected, 'disposable PostgreSQL unavailable');
const identity = 'c'.repeat(64);
afterAll(async () => {
  if (runDb) await query('DELETE FROM cos_release_synchronizations WHERE identity = $1', [identity]);
  if (health.connected) await close();
});

describe.skipIf(!runDb)('publication ownership on PostgreSQL', () => {
  it('admits one concurrent owner and allows only that immutable dispatch to advance', async () => {
    await query('DELETE FROM cos_release_synchronizations WHERE identity = $1', [identity]);
    const entry = agentId => ({ version: 1, identity, owner: { agentId }, publication: { identity },
      task: { id: `task-release-sync-${identity}` }, checkouts: [], obligations: { retirement: { status: 'pending' } },
      registeredAt: null, attempts: 0, lastAttemptAt: null, blocker: null, retryAt: null });
    const outcomes = await Promise.allSettled([saveReleaseSynchronization(entry('example-one')), saveReleaseSynchronization(entry('example-two'))]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const saved = (await readReleaseSynchronizationOutbox()).publications[identity];
    const advanced = { ...saved, attempts: 1, registeredAt: '2026-01-01T00:00:00Z',
      obligations: { retirement: { status: 'blocked', blocker: 'exact-retirement-receipt-unverified' } },
      synchronization: { status: 'blocked', attempts: 1 } };
    await saveReleaseSynchronization(advanced);
    expect((await readReleaseSynchronizationOutbox()).publications[identity]).toEqual(advanced);
    await expect(saveReleaseSynchronization({ ...advanced, task: { id: 'task-competing' } })).rejects.toThrow('immutable ownership');
    const recovered = { ...advanced, legacyRecovery: { version: 1, digest: 'd'.repeat(64) } };
    await saveReleaseSynchronization(recovered);
    await expect(saveReleaseSynchronization(advanced)).rejects.toThrow('immutable ownership');
    await expect(saveReleaseSynchronization({ ...recovered, legacyRecovery: { version: 1, digest: 'e'.repeat(64) } })).rejects.toThrow('immutable ownership');
    expect((await readReleaseSynchronizationOutbox()).publications[identity]).toEqual(recovered);
  });
});
