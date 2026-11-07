/**
 * Live restore of a real pg_dump (#15280). The pinned image dumps the shipped
 * base schema plus a second schema, a function and a trigger, using the
 * snapshot backup's own flags. The dump then goes through the restore's
 * admission and replay preparation into a scratch database, and the startup
 * maintenance-schema probe must pass on the result.
 *
 * The hosted DB job runs this explicitly, outside the test memo, so a missing
 * Docker engine, image or psql fails rather than skipping into a cached pass:
 *
 *   cd server && PORTOS_DB_RESTORE_LIVE=1 npx vitest run services/backupDatabaseDump.restore.live.test.js
 *
 * Locally, `.env` selects the install's Postgres (PGMODE), and the image must
 * already be pulled: the container runs with --pull=never.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_MAINTENANCE_SCHEMA_SQL, databaseMaintenanceSchemaHealthy } from '../lib/databaseMaintenanceSchema.js';
import { inspectDatabaseDump, prepareDatabaseReplay, SNAPSHOT_PG_DUMP_FLAGS } from './backupDatabaseDump.js';
import { createScratchDb, dropScratchDb, resolveAdminConnection } from '../../scripts/rehearsal-scratch-db.js';
import { PINNED_DB_IMAGE } from '../../scripts/lib/dbImage.js';

const LIVE = process.env.PORTOS_DB_RESTORE_LIVE === '1';
const { Client } = createRequire(import.meta.url)('pg');

const MEMORY_ID = '00000000-0000-4000-8000-000000000001';
// Synthetic rows only. The receipt row proves --exclude-table-data held.
const SEED_EXTRAS = `
INSERT INTO memories (id, type, content, embedding)
  VALUES ('${MEMORY_ID}', 'fact', 'Example restored memory', array_fill(0.5::real, ARRAY[768])::vector);
INSERT INTO restore_receipts (operation_id, dump_sha256) VALUES (gen_random_uuid(), 'example');
CREATE SCHEMA restore_probe;
CREATE TABLE restore_probe.events (id integer PRIMARY KEY, label text NOT NULL, stamped text);
CREATE FUNCTION restore_probe.stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.stamped := upper(NEW.label); RETURN NEW; END $$;
CREATE TRIGGER events_stamp BEFORE INSERT OR UPDATE ON restore_probe.events
  FOR EACH ROW EXECUTE FUNCTION restore_probe.stamp();
INSERT INTO restore_probe.events (id, label) VALUES (1, 'dumped');
`;

// A network-less, read-only container with tmpfs storage: nothing from the
// host is mounted, and the seed arrives on stdin. pg_dump writes to stdout.
const DUMP_SCRIPT = 'umask 077; initdb -D /var/lib/postgresql/data -U fixture_admin --auth=trust --no-locale --encoding=UTF8 >/dev/null '
  + '&& pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log -o "-c listen_addresses= -c unix_socket_directories=/tmp -c shared_buffers=32MB" -w start >/dev/null '
  + '&& psql -X -q -v ON_ERROR_STOP=1 -h /tmp -U fixture_admin -d postgres >/dev/null '
  + '&& pg_dump -h /tmp -U fixture_admin -d postgres "$@"';

// spawnSync blocks the hook's own timer, so the dump, its container removal and
// the replay (60 + 30 + 60 s) must fit inside the 180 s beforeAll budget.
const COMMAND_TIMEOUT_MS = 60000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr.trim().slice(-2000)}`);
  return result.stdout;
}

function realPgDump(seed) {
  const name = `portos-restore-fixture-${randomBytes(8).toString('hex')}`;
  try {
    return run('docker', ['run', '--rm', '-i', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--user', '999:999', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
      '--memory=1g', '--memory-swap=1g', '--log-driver=none',
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=768m,uid=999,gid=999,mode=0700',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
      '--entrypoint', '/bin/sh', PINNED_DB_IMAGE, '-c', DUMP_SCRIPT, 'sh', ...SNAPSHOT_PG_DUMP_FLAGS], { input: seed });
  } finally {
    spawnSync('docker', ['rm', '--force', '--volumes', name], { encoding: 'utf8', timeout: 30000 });
  }
}

describe.skipIf(!LIVE)('restore of a real pg_dump into a scratch database', () => {
  let directory;
  let connection;
  let scratch;
  let dumpText;
  let replayText;

  const withScratch = async (fn) => {
    const client = new Client({ ...connection, database: scratch.database, connectionTimeoutMillis: 5000 });
    await client.connect();
    try { return await fn(client); } finally { await client.end().catch(() => {}); }
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'portos-restore-live-'));
    const initSql = await readFile(new URL('../scripts/init-db.sql', import.meta.url), 'utf8');
    dumpText = realPgDump(`${initSql}\n${SEED_EXTRAS}`);
    const dumpPath = join(directory, 'portos-db.sql');
    await writeFile(dumpPath, dumpText, { mode: 0o600 });

    // The common restore target is an initialized install, so the scratch
    // database carries the base schema, as `npm run setup:db:test` builds it.
    connection = resolveAdminConnection();
    scratch = await createScratchDb(connection);
    const targetServerMajor = await withScratch(async client => Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num) / 10000));

    const dump = await inspectDatabaseDump(dumpPath, { spoolTo: join(directory, 'spool.sql'), targetServerMajor });
    expect(dump).toMatchObject({ complete: true, missingTables: [] });
    const replayPath = await prepareDatabaseReplay(join(directory, 'spool.sql'), dump.extensionMetadata);
    replayText = await readFile(replayPath, 'utf8');
    run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction',
      '-h', connection.host, '-p', String(connection.port), '-U', connection.user, '-d', scratch.database, '-f', replayPath],
    { env: { ...process.env, PGPASSWORD: connection.password } });
  }, 180000);

  afterAll(async () => {
    try {
      if (scratch) await dropScratchDb(scratch.database, connection);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('is a production-flag dump with extensions, a second schema, a function and a trigger', () => {
    expect(dumpText).toMatch(/^CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;$/m);
    expect(dumpText).toMatch(/^CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;$/m);
    expect(dumpText).toMatch(/^DROP EXTENSION IF EXISTS vector;$/m);
    expect(dumpText).toMatch(/^CREATE SCHEMA restore_probe;$/m);
    expect(dumpText).toMatch(/^CREATE FUNCTION restore_probe\.stamp\(\)/m);
    expect(dumpText).toMatch(/^CREATE TRIGGER events_stamp /m);
    expect(dumpText).not.toMatch(/^ALTER .* OWNER TO /m);
    expect(dumpText).not.toMatch(/^COMMENT ON /m);
  });

  it('replays without the clean-dump extension drops the restore role may not own', () => {
    expect(replayText).not.toMatch(/^DROP EXTENSION/m);
    expect(replayText).toMatch(/^CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;$/m);
  });

  it('restores a database that passes the startup maintenance-schema probe', async () => {
    const health = await withScratch(async client => (await client.query(DATABASE_MAINTENANCE_SCHEMA_SQL)).rows[0]);
    expect(health.database).toBe(scratch.database);
    expect(databaseMaintenanceSchemaHealthy(health), JSON.stringify(health)).toBe(true);
  });

  it('restores rows, extension data, the second schema and a working trigger', async () => {
    await withScratch(async (client) => {
      const memory = (await client.query('SELECT content, vector_dims(embedding) AS dims FROM memories WHERE id = $1', [MEMORY_ID])).rows;
      expect(memory).toEqual([{ content: 'Example restored memory', dims: 768 }]);
      expect((await client.query('SELECT count(*)::int AS n FROM restore_receipts')).rows[0].n).toBe(0);
      expect((await client.query("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto') ORDER BY extname")).rows)
        .toEqual([{ extname: 'pgcrypto' }, { extname: 'vector' }]);
      await client.query("INSERT INTO restore_probe.events (id, label) VALUES (2, 'restored')");
      expect((await client.query('SELECT id, stamped FROM restore_probe.events ORDER BY id')).rows)
        .toEqual([{ id: 1, stamped: 'DUMPED' }, { id: 2, stamped: 'RESTORED' }]);
    });
  });
});
