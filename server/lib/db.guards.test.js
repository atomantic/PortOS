/**
 * Test-runner safety guards in db.js (incident #1248-follow-up).
 *
 * On 2026-06-13 a CoS agent ran the server test suite in its worktree; the
 * DB-backed `*.db.test.js` suites — which connect to the single real `portos`
 * Postgres and run `DELETE FROM universes` — wiped every universe/series when the
 * agent's process was torn down before their snapshot-restore could finish.
 *
 * These guards make the test runner refuse to touch a NON-test database:
 *   - isTestDatabase()  — names a DB safe for destructive tests.
 *   - checkHealth()     — reports "disconnected" under NODE_ENV=test on a real DB
 *                         so every db-backed suite skips via its existing branch.
 *   - query()           — hard backstop: throws on DELETE/TRUNCATE under
 *                         NODE_ENV=test on a non-test DB even if a suite reaches
 *                         it without gating on checkHealth first.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isTestDatabase, checkHealth, query } from './db.js';

// NODE_ENV is 'test' throughout (vitest default); we vary PGDATABASE / TEST_DB_OK.
const saved = {};
function setEnv(key, value) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

describe('isTestDatabase', () => {
  it('treats the production default name as NOT a test DB', () => {
    setEnv('PGDATABASE', undefined); // → defaults to 'portos'
    setEnv('TEST_DB_OK', undefined);
    expect(isTestDatabase()).toBe(false);
  });

  it('treats an explicit production name as NOT a test DB', () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    expect(isTestDatabase()).toBe(false);
  });

  it('accepts the canonical portos_test name', () => {
    setEnv('PGDATABASE', 'portos_test');
    setEnv('TEST_DB_OK', undefined);
    expect(isTestDatabase()).toBe(true);
  });

  it('accepts any *_test database name', () => {
    setEnv('PGDATABASE', 'myfork_test');
    setEnv('TEST_DB_OK', undefined);
    expect(isTestDatabase()).toBe(true);
  });

  it('honors the TEST_DB_OK=1 override even on a non-test name', () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', '1');
    expect(isTestDatabase()).toBe(true);
  });

  it('ignores TEST_DB_OK values other than "1"', () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', 'true');
    expect(isTestDatabase()).toBe(false);
  });
});

describe('checkHealth test-runner gate', () => {
  it('reports disconnected on a non-test DB under NODE_ENV=test', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    const health = await checkHealth();
    expect(health.connected).toBe(false);
    expect(health.hasSchema).toBe(false);
    expect(health.error).toMatch(/test runner blocked/i);
  });
});

describe('query destructive backstop', () => {
  // These all run with a non-test DB so the guard is active. The throw happens
  // BEFORE pool.query, so no live database is needed.
  it('throws on DELETE FROM against a non-test DB', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(query('DELETE FROM universes')).rejects.toThrow(/Refusing destructive query/i);
  });

  it('throws on TRUNCATE against a non-test DB', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(query('TRUNCATE pipeline_series')).rejects.toThrow(/Refusing destructive query/i);
  });

  it('throws even when the statement is prefixed with comments/whitespace', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(query('  -- cleanup\n  DELETE FROM writers_room_works')).rejects.toThrow(
      /Refusing destructive query/i,
    );
  });

  it('does NOT block non-destructive statements via the guard', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    // A SELECT is not destructive — the guard lets it through to pool.query.
    // We only assert the guard's own error is NOT thrown; any connection error
    // from pool.query (no DB in CI) is fine and distinct.
    await query('SELECT 1').then(
      () => {},
      (err) => expect(err.message).not.toMatch(/Refusing destructive query/i),
    );
  });

  it('does not false-positive on a column/word containing "delete"', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await query("SELECT deleted FROM universes WHERE name = 'x'").then(
      () => {},
      (err) => expect(err.message).not.toMatch(/Refusing destructive query/i),
    );
  });
});
