/**
 * DB-backed coverage for the importDumpFile abort path (#7213): a dump read
 * failure after complete destructive SQL must terminate the psql child so the
 * interrupted --single-transaction rolls back — preexisting rows in the target
 * database survive.
 *
 * The psql child is REAL — the spawn spy delegates to the real process.
 * Only the dump source is synthetic: createReadStream is wrapped so the test can substitute a Readable
 * that delivers a complete destructive prefix and then fails the read. Runs
 * only under `npm run test:db` against the throwaway portos_test database.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { spawn, spawnSync } from '../lib/childProcess.js';
import { checkHealth, close, query, POOL_CONFIG } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importDumpFile, _importReplayFile } from './dbAdmin.js';

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
  it('restores as an unprivileged role with a foreign-owned vector extension and rolls back invalid SQL', async () => {
    const authority = await query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
    const provisionRole = authority.rows[0].rolsuper;
    const role = 'import_probe_' + randomUUID().replaceAll('-', '');
    const schema = role;
    const dir = mkdtempSync(join(tmpdir(), 'portos-import-db-'));
    try {
      await query('CREATE EXTENSION IF NOT EXISTS vector');
      if (provisionRole) await query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER`);
      await query(`CREATE SCHEMA ${schema}${provisionRole ? ' AUTHORIZATION ' + role : ''}`);
      const prefix = provisionRole ? `SET ROLE ${role};\n` : '';
      await query(`${prefix}CREATE TABLE ${schema}.probe (id int); INSERT INTO ${schema}.probe VALUES (1); RESET ROLE;`);
      const ownerSql = provisionRole
        ? "SELECT extowner <> (SELECT oid FROM pg_roles WHERE rolname = $1) AS foreign_owner FROM pg_extension WHERE extname = 'vector'"
        : "SELECT extowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user) AS foreign_owner FROM pg_extension WHERE extname = 'vector'";
      const ownerArgs = provisionRole ? [role] : [];
      const foreignOwner = await query(ownerSql, ownerArgs);
      expect(foreignOwner.rows[0].foreign_owner).toBe(true);
      const clean = `DROP TABLE IF EXISTS ${schema}.probe;\nCREATE TABLE ${schema}.probe (id int);\nINSERT INTO ${schema}.probe VALUES (2);\n`;
      const file = join(dir, 'legacy.sql');
      // Raw replay reproduces the ownership failure under the application role.
      writeFileSync(file, prefix + 'DROP EXTENSION IF EXISTS vector;\n');
      const refused = await _importReplayFile(file, PORT, { ...process.env });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain('must be owner of extension vector');
      const imports = [file => importDumpFile(file, PORT, { ...process.env })];
      if (process.platform !== 'win32') imports.push(async file => {
        const child = spawnSync('bash', [fileURLToPath(new URL('../../scripts/db.sh', import.meta.url)),
          'import', '--endpoint', POOL_CONFIG.host, String(POOL_CONFIG.port), POOL_CONFIG.user, POOL_CONFIG.database, file], {
          env: { ...process.env, PGPASSWORD: POOL_CONFIG.password }, encoding: 'utf8', timeout: 15_000,
        });
        return { exitCode: child.status, stderr: child.stderr };
      });
      for (const load of imports) {
        writeFileSync(file, prefix + "DROP EXTENSION IF EXISTS vector;\nCOMMENT ON EXTENSION vector IS 'legacy';\n" + clean);
        expect((await load(file)).exitCode).toBe(0);
        expect((await query(`SELECT id FROM ${schema}.probe`)).rows).toEqual([{ id: 2 }]);
        writeFileSync(file, prefix + clean.replace('VALUES (2)', 'VALUES (3)') + 'INVALID SQL;\n');
        expect((await load(file)).exitCode).not.toBe(0);
        expect((await query(`SELECT id FROM ${schema}.probe`)).rows).toEqual([{ id: 2 }]);
      }
      expect((await query(ownerSql, ownerArgs)).rows[0].foreign_owner).toBe(true);
    } finally {
      await query('RESET ROLE');
      await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (provisionRole) await query(`DROP ROLE IF EXISTS ${role}`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves preexisting target rows when the dump read fails mid-import', async () => {
    // The target's pre-sync "recovery copy": a table with a row the dump would
    // destroy and repopulate.
    await query(`DROP TABLE IF EXISTS ${TABLE}`);
    await query(`CREATE TABLE ${TABLE} (id int)`);
    await query(`INSERT INTO ${TABLE} VALUES (1)`);

    // Wait for psql to acknowledge execution, so slow startup cannot turn this
    // into a passing test that killed the child before any destructive SQL ran.
    const marker = 'IMPORT_ABORT_PREFIX_EXECUTED';
    let acknowledge;
    const prefixExecuted = new Promise((resolve) => { acknowledge = resolve; });
    let markerSeen = false;
    createReadStream.mockImplementationOnce(() => Readable.from((async function* () {
      yield `DROP TABLE IF EXISTS ${TABLE};\n` +
            `CREATE TABLE ${TABLE} (id int);\n` +
            `INSERT INTO ${TABLE} VALUES (2);\n` +
            `\\echo ${marker}\n`;
      let deadline;
      try {
        await Promise.race([
          prefixExecuted,
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('psql did not execute prefix')), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      throw new Error('simulated dump read failure');
    })(), { encoding: 'latin1' }));

    const importing = _importReplayFile('/unused/dump.sql', PORT, { ...process.env }, 15_000);
    const child = spawn.mock.results.at(-1).value;
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        markerSeen = true;
        acknowledge();
      }
    });
    const result = await importing;

    expect(markerSeen).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('simulated dump read failure');

    // The DROP + INSERT prefix never committed — the preexisting row survived.
    const rows = await query(`SELECT id FROM ${TABLE} ORDER BY id`);
    expect(rows.rows.map((r) => r.id)).toEqual([1]);
  });
});
