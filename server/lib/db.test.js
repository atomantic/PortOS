/**
 * Postgres-backed regression coverage for the boot-schema-DDL race (#5977):
 * two processes calling `ensureSchema()` at once used to interleave their
 * `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER` pairs and throw "already
 * exists". `ensureSchemaImpl()` now wraps the whole DDL block in a
 * session-level `pg_advisory_lock`, held on a dedicated client for the
 * duration of the block and released in `finally`.
 *
 * These tests hold/probe the SAME advisory lock key from a second, raw `pg`
 * client to prove the lock is actually cross-session (not just the existing
 * in-process `ensureSchemaInFlight` dedup, which a second process doesn't
 * share) and that it is released on both the success and throw path.
 *
 * `*.db.test.js`-style suite (named `db.test.js`, matched by the
 * `**\/db.test.js` glob in `vitest.config.db.js`) → runs ONLY via
 * `npm run test:db` against `portos_test`, never the real `portos` DB (the
 * db.js runner guard + the skip below enforce this).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { requireDbOrSkip } from './dbTestGate.js';

const injectionState = vi.hoisted(() => ({ badUpgradeDdl: false }));

vi.mock('./db/schema/index.js', async () => {
  const actual = await vi.importActual('./db/schema/index.js');
  return {
    ...actual,
    buildUpgradeDdl: () =>
      injectionState.badUpgradeDdl
        ? ['SELECT * FROM this_table_does_not_exist_5977']
        : actual.buildUpgradeDdl(),
  };
});

const { checkHealth, ensureSchema, close, POOL_CONFIG, SCHEMA_DDL_ADVISORY_LOCK_KEY } = await import('./db.js');

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('lib/db.test', dbReady, skipReason);

// A second, independent connection to the same database — reuses db.js's own
// POOL_CONFIG so it can never drift from what the pool under test connects to.
function makeRawClient() {
  return new pg.Client(POOL_CONFIG);
}

// Always unlock-and-close the holder client, even when an assertion in
// `run` throws — an unreleased holder leaves the advisory lock held forever,
// which would hang every later ensureSchema() call (including afterAll's
// close()) rather than just failing this one test.
async function withLockHolder(run) {
  const holder = makeRawClient();
  await holder.connect();
  try {
    return await run(holder);
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [SCHEMA_DDL_ADVISORY_LOCK_KEY]).catch(() => {});
    await holder.end();
  }
}

afterAll(async () => {
  if (dbReady) await close();
});

describe.skipIf(!runDb)('ensureSchema() boot DDL advisory lock (#5977)', () => {
  beforeAll(async () => {
    // Baseline: schema already applied once so later assertions aren't
    // measuring first-install DDL cost.
    await ensureSchema();
  });

  it('blocks behind a lock held by another session, then completes once it frees', async () => {
    let resolved = false;
    let schemaPromise;

    await withLockHolder(async (holder) => {
      await holder.query('SELECT pg_advisory_lock($1)', [SCHEMA_DDL_ADVISORY_LOCK_KEY]);

      schemaPromise = ensureSchema().then(() => { resolved = true; });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(resolved).toBe(false);
    });

    await schemaPromise;
    expect(resolved).toBe(true);
  });

  it('releases the lock (and rejects) when the DDL block throws', async () => {
    injectionState.badUpgradeDdl = true;
    await expect(ensureSchema()).rejects.toThrow();
    injectionState.badUpgradeDdl = false;

    await withLockHolder(async (holder) => {
      const { rows } = await holder.query('SELECT pg_try_advisory_lock($1) AS locked', [SCHEMA_DDL_ADVISORY_LOCK_KEY]);
      expect(rows[0].locked).toBe(true);
    });

    // The DDL block still runs on every call — a genuine schema error on one
    // call must not leave a later, valid call permanently blocked or skipped.
    await expect(ensureSchema()).resolves.toBeUndefined();
  });
});
