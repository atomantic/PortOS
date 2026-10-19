import { describe, expect, it, vi } from 'vitest';
import { DB_RUN_ADVISORY_LOCK_KEY, acquireDbRunLock } from './dbRunExclusivity.js';
import dbConfig from '../vitest.config.db.js';

// A lock that is free the first time it is tried; `held` makes try-lock fail and
// the blocking call wait until `grant()` — the shape of a peer run in progress.
function fakeClient({ held = false, connectError = null } = {}) {
  const grant = Promise.withResolvers();
  const calls = [];
  const client = {
    on: vi.fn(),
    connect: vi.fn(async () => { if (connectError) throw connectError; }),
    end: vi.fn(async () => {}),
    query: vi.fn(async sql => {
      calls.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: !held }] };
      if (sql.includes('pg_advisory_lock')) await grant.promise;
      return { rows: [] };
    }),
  };
  return { client, calls, grant: () => grant.resolve() };
}

describe('acquireDbRunLock', () => {
  it('holds the lock for the whole run and unlocks on release', async () => {
    const { client, calls } = fakeClient();
    const release = await acquireDbRunLock({ env: {}, createClient: () => client, log: vi.fn() });
    expect(calls).toEqual(['SELECT pg_try_advisory_lock($1) AS locked']);
    expect(client.end).not.toHaveBeenCalled();
    await release();
    expect(calls.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(client.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock($1)', [DB_RUN_ADVISORY_LOCK_KEY]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('queues behind a run that holds the lock instead of overlapping it', async () => {
    const { client, calls, grant } = fakeClient({ held: true });
    const log = vi.fn();
    let acquired = false;
    const pending = acquireDbRunLock({ env: {}, createClient: () => client, log }).then(release => { acquired = true; return release; });
    await vi.waitFor(() => expect(calls).toContain('SELECT pg_advisory_lock($1)'));
    expect(acquired).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('waiting'));
    grant();
    await (await pending)();
    expect(acquired).toBe(true);
  });

  it('targets PGTESTDATABASE and refuses to lock a non-test database', async () => {
    const config = vi.fn(() => fakeClient().client);
    await acquireDbRunLock({ env: { PGTESTDATABASE: 'custom_test' }, createClient: config, log: vi.fn() });
    expect(config).toHaveBeenCalledWith(expect.objectContaining({ database: 'custom_test' }));

    const refused = vi.fn();
    const release = await acquireDbRunLock({ env: { PGTESTDATABASE: 'portos' }, createClient: refused, log: vi.fn() });
    expect(refused).not.toHaveBeenCalled();
    await release();
  });

  it('does not block the run when Postgres is unreachable (the suites skip themselves)', async () => {
    const { client } = fakeClient({ connectError: new Error('ECONNREFUSED') });
    const release = await acquireDbRunLock({ env: {}, createClient: () => client, log: vi.fn() });
    expect(client.query).not.toHaveBeenCalled();
    await release();
  });
});

describe('vitest.config.db.js', () => {
  it('takes the run lock before the temp-root setup', () => {
    const setups = dbConfig.test.globalSetup.map(path => path.replaceAll('\\', '/'));
    const lock = setups.findIndex(path => path.endsWith('/test/dbRunExclusivity.js'));
    const tempRoot = setups.findIndex(path => path.endsWith('/scripts/vitestTempRootSetup.js'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(tempRoot);
  });
});
