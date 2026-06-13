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
import { readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestDatabase, checkHealth, query } from './db.js';
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
