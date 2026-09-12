/**
 * DB-backed coverage for the importDumpFile abort path (#7213): a dump read
 * failure after complete destructive SQL must terminate the psql child so the
 * interrupted --single-transaction rolls back — preexisting rows in the target
 * database survive.
 *
 * The psql child is REAL — spawn is not mocked. Only the dump source is
 * synthetic: createReadStream is wrapped so the test can substitute a Readable
 * that delivers a complete destructive prefix and then fails the read. Runs
 * only under `npm run test:db` against the throwaway portos_test database.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { spawnSync } from '../lib/childProcess.js';
import { checkHealth, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

import { importDumpFile } from './dbAdmin.js';

const TABLE = 'import_abort_probe';
const PORT = process.env.PGPORT || '5432';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((error) => ({ connected: false, error: error?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else if (spawnSync('psql', ['--version']).status !== 0) {
    // The import path drives the real psql client binary — without it there is
    // nothing to abort and nothing to prove.
    skipReason = 'psql client binary not on PATH';
  } else {
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/dbAdmin.db.test', dbReady, skipReason);

afterAll(async () => {
  if (dbReady) {
    await query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await close();
  }
});

describe.skipIf(!runDb)('importDumpFile abort rolls back the interrupted import (#7213)', () => {
  it('preserves preexisting target rows when the dump read fails mid-import', async () => {
    // The target's pre-sync "recovery copy": a table with a row the dump would
    // destroy and repopulate.
    await query(`DROP TABLE IF EXISTS ${TABLE}`);
    await query(`CREATE TABLE ${TABLE} (id int)`);
    await query(`INSERT INTO ${TABLE} VALUES (1)`);

    // The dump's destructive prefix is delivered to psql whole — including a
    // pg_sleep that keeps psql inside the open transaction long enough for the
    // read failure to land mid-script — then the read fails. The 300ms pacing
    // gap lets the real child consume the pipe before the error arrives.
    createReadStream.mockImplementationOnce(() => Readable.from((async function* () {
      yield `DROP TABLE IF EXISTS ${TABLE};\n` +
            `CREATE TABLE ${TABLE} (id int);\n` +
            `INSERT INTO ${TABLE} VALUES (2);\n` +
            'SELECT pg_sleep(0.5);\n';
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw new Error('simulated dump read failure');
    })(), { encoding: 'latin1' }));

    const result = await importDumpFile('/unused/dump.sql', PORT, { ...process.env }, 15_000);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('simulated dump read failure');

    // The DROP + INSERT prefix never committed — the preexisting row survived.
    const rows = await query(`SELECT id FROM ${TABLE} ORDER BY id`);
    expect(rows.rows.map((r) => r.id)).toEqual([1]);
  });
});
