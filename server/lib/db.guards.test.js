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
 *   - isTestRunner()    — detects the runner via NODE_ENV=test OR the VITEST env
 *                         var (set in every vitest worker), so a worktree run
 *                         that left NODE_ENV unset is still gated.
 *   - checkHealth()     — reports "disconnected" under the test runner on a real
 *                         DB so every db-backed suite skips via its existing branch.
 *   - query()           — hard backstop: throws on ANY row write (INSERT/UPDATE/
 *                         DELETE/TRUNCATE) under the test runner on a non-test DB
 *                         even if a suite reaches it without gating on checkHealth
 *                         first. (DELETE-only guarding let test INSERTs leak
 *                         fixtures into the real `portos` DB on 2026-06-14.)
 *   - withTransaction() — the SAME backstop on the raw pg client it hands the
 *                         callback. client.query() bypasses query() entirely, so
 *                         every store mutation that writes inside a transaction
 *                         (updateAuthor, deleteAuthor, mergeAuthorsFromSync,
 *                         universe runs, catalog, writers-room) wrote to the real
 *                         `portos` DB unguarded under VITEST until this was added.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestDatabase, isTestRunner, checkHealth, query, assertWriteAllowed } from './db.js';
import { DB_TEST_INCLUDE } from '../vitest.config.db.js';

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

describe('isTestRunner', () => {
  it('is true under NODE_ENV=test', () => {
    setEnv('NODE_ENV', 'test');
    setEnv('VITEST', undefined);
    expect(isTestRunner()).toBe(true);
  });

  it('is true via VITEST even when NODE_ENV is not "test"', () => {
    // The leak path: a worktree wrapper sets NODE_ENV=development, so backend
    // selectors keyed on bare NODE_ENV quietly choose Postgres. VITEST is still
    // set, so the runner is still detected and the guard stays armed.
    setEnv('NODE_ENV', 'development');
    setEnv('VITEST', 'true');
    expect(isTestRunner()).toBe(true);
  });

  it('is false outside the runner (no NODE_ENV=test, no VITEST)', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('VITEST', undefined);
    expect(isTestRunner()).toBe(false);
  });
});

describe('checkHealth test-runner gate', () => {
  it('reports disconnected on a non-test DB under the test runner', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    const health = await checkHealth();
    expect(health.connected).toBe(false);
    expect(health.hasSchema).toBe(false);
    expect(health.error).toMatch(/test runner blocked/i);
  });

  it('reports disconnected via VITEST even when NODE_ENV is not "test"', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    setEnv('NODE_ENV', 'development');
    setEnv('VITEST', 'true');
    const health = await checkHealth();
    expect(health.connected).toBe(false);
  });
});

describe('query row-write backstop', () => {
  // These all run with a non-test DB so the guard is active. The throw happens
  // BEFORE pool.query, so no live database is needed.
  it('throws on DELETE FROM against a non-test DB', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(query('DELETE FROM universes')).rejects.toThrow(/Refusing to mutate/i);
  });

  it('throws on TRUNCATE against a non-test DB', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(query('TRUNCATE pipeline_series')).rejects.toThrow(/Refusing to mutate/i);
  });

  it('throws on INSERT INTO against a non-test DB (the fixture-leak path)', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(
      query("INSERT INTO pipeline_series (id, data) VALUES ('ser-fixed-abc', '{}')"),
    ).rejects.toThrow(/Refusing to mutate/i);
  });

  it('throws on UPDATE against a non-test DB', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(query("UPDATE universes SET deleted = TRUE WHERE id = 'x'")).rejects.toThrow(
      /Refusing to mutate/i,
    );
  });

  it('throws on a write via VITEST even when NODE_ENV is not "test"', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    setEnv('NODE_ENV', 'development');
    setEnv('VITEST', 'true');
    await expect(query("INSERT INTO universes (id) VALUES ('x')")).rejects.toThrow(
      /Refusing to mutate/i,
    );
  });

  it('throws even when the statement is prefixed with comments/whitespace', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await expect(query('  -- cleanup\n  DELETE FROM writers_room_works')).rejects.toThrow(
      /Refusing to mutate/i,
    );
  });

  it('does NOT block reads via the guard', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    // A SELECT is not a row write — the guard lets it through to pool.query. We
    // only assert the guard's own error is NOT thrown; any connection error
    // from pool.query (no DB in CI) is fine and distinct.
    await query('SELECT 1').then(
      () => {},
      (err) => expect(err.message).not.toMatch(/Refusing to mutate/i),
    );
  });

  it('does not false-positive on a column/word containing "delete"/"update"', async () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    await query("SELECT deleted, updated_at FROM universes WHERE name = 'x'").then(
      () => {},
      (err) => expect(err.message).not.toMatch(/Refusing to mutate/i),
    );
  });
});

// The shared backstop used by BOTH query() and the withTransaction client. The
// transaction path is the one that actually leaked: nearly every store mutation
// (updateAuthor, deleteAuthor, mergeAuthorsFromSync, universe runs, catalog,
// writers-room) runs its INSERT/UPDATE/DELETE through `client.query()` inside a
// transaction, which talks to the raw pg client — NOT this module's query(). We
// can't open a real transaction in CI (no DB), so we test the guard the proxy
// wraps directly: assertWriteAllowed sees the exact SQL the proxy forwards it.
describe('assertWriteAllowed (shared query + transaction-client backstop)', () => {
  it('throws on a row write against a non-test DB under the runner', () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    expect(() => assertWriteAllowed("INSERT INTO authors (id) VALUES ('x')")).toThrow(
      /Refusing to mutate/i,
    );
    expect(() => assertWriteAllowed('DELETE FROM universes')).toThrow(/Refusing to mutate/i);
    expect(() => assertWriteAllowed("UPDATE pipeline_series SET name = 'x'")).toThrow(
      /Refusing to mutate/i,
    );
  });

  it('allows transaction control statements (BEGIN/COMMIT/ROLLBACK) and reads', () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    // These are exactly the statements withTransaction runs around the callback,
    // plus the SELECT … FOR UPDATE reads the store mutations issue first.
    expect(() => assertWriteAllowed('BEGIN')).not.toThrow();
    expect(() => assertWriteAllowed('COMMIT')).not.toThrow();
    expect(() => assertWriteAllowed('ROLLBACK')).not.toThrow();
    expect(() => assertWriteAllowed('SELECT data FROM authors WHERE id = $1 FOR UPDATE')).not.toThrow();
  });

  it('allows row writes against a designated test DB', () => {
    setEnv('PGDATABASE', 'portos_test');
    setEnv('TEST_DB_OK', undefined);
    expect(() => assertWriteAllowed("INSERT INTO authors (id) VALUES ('x')")).not.toThrow();
  });

  it('tolerates a non-string arg (a config object with no .text reaches it as undefined)', () => {
    setEnv('PGDATABASE', 'portos');
    setEnv('TEST_DB_OK', undefined);
    // The transaction proxy passes config?.text; a parameterless control call
    // can surface undefined here — it must not throw on a non-string.
    expect(() => assertWriteAllowed(undefined)).not.toThrow();
  });
});

// Drift guard: a DB-backed suite skips on a non-test DB (correct), so if a new
// one is left out of vitest.config.db.js it would simply NEVER run — silently
// losing coverage with a green board. This asserts every real DB-backed suite
// (identified by the checkHealth + dbReady gating pattern those suites share) is
// matched by the db-config include set. Suites that MOCK checkHealth (no dbReady
// gate, e.g. memoryBackend.test.js) are not DB-backed and are correctly excluded.
describe('DB-backed test files are covered by vitest.config.db.js', () => {
  it('every checkHealth+dbReady suite is in the db-config include set', () => {
    const HERE = dirname(fileURLToPath(import.meta.url)); // server/lib
    const SERVER = join(HERE, '..'); // vitest root for the db config
    const REPO_SCRIPTS = join(SERVER, '..', 'scripts');

    const hasDbGlob = DB_TEST_INCLUDE.includes('**/db.test.js');
    // Match by basename — robust to the `../scripts/` relative-path prefix. The
    // explicit include entries all have distinct basenames, so this can't
    // false-match.
    const explicitBasenames = new Set(
      DB_TEST_INCLUDE.filter((p) => p !== '**/db.test.js').map((p) => p.split('/').pop()),
    );

    // The checkHealth + dbReady gating always sits in a suite's first ~40 lines,
    // so read only the file header instead of slurping every test file whole.
    // 8 KB leaves generous margin past the gating block (routes/catalog.test.js
    // already reaches ~1.8 KB) without slurping large suites whole.
    const readHead = (path, bytes = 8192) => {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(bytes);
        return buf.toString('utf8', 0, readSync(fd, buf, 0, bytes, 0));
      } finally {
        closeSync(fd);
      }
    };

    const SKIP_DIRS = new Set(['node_modules', 'slashdo', 'coverage', '.git']);
    const collect = (root) => {
      let entries;
      try {
        entries = readdirSync(root, { recursive: true });
      } catch {
        return [];
      }
      return entries
        .map(String)
        .filter((p) => p.endsWith('.test.js') && !p.split(sep).some((seg) => SKIP_DIRS.has(seg)));
    };

    const offenders = [];
    for (const [root, prefix] of [[SERVER, ''], [REPO_SCRIPTS, '../scripts/']]) {
      for (const rel of collect(root)) {
        const base = rel.split(sep).pop();
        // This guard file itself references checkHealth/dbReady (imports + the
        // detector regex) but is not a DB-backed suite — exclude it.
        if (base === 'db.guards.test.js') continue;
        const head = readHead(join(root, rel));
        // A real DB-backed suite both gates on checkHealth() and exposes dbReady.
        if (!(/\bcheckHealth\b/.test(head) && /\bdbReady\b/.test(head))) continue;
        const covered = (hasDbGlob && base === 'db.test.js') || explicitBasenames.has(base);
        if (!covered) offenders.push(prefix + rel.split(sep).join('/'));
      }
    }

    expect(
      offenders,
      `These DB-backed suites use checkHealth()+dbReady but are missing from ` +
        `server/vitest.config.db.js include — they would never run against portos_test:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every explicit DB_TEST_INCLUDE entry resolves to a real file', () => {
    // Basename matching above proves a suite IS listed, but not that its include
    // PATH is correct — a wrong path (e.g. `../scripts/x` for a file under
    // `scripts/x`) matches no file in vitest yet is "covered" by basename, so the
    // suite silently never runs. Resolve each non-glob entry against the config
    // root (server/) and assert it exists.
    const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
    const broken = DB_TEST_INCLUDE
      .filter((p) => !p.includes('*'))
      .filter((p) => !existsSync(join(SERVER, p)));
    expect(
      broken,
      `These vitest.config.db.js include paths resolve to no file (relative to server/):\n  ${broken.join('\n  ')}`,
    ).toEqual([]);
  });
});
