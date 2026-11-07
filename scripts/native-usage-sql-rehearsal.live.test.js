import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNativeUsageRehearsalCli } from './native-usage-rehearse.js';
import { NATIVE_USAGE_SQL_IMAGE } from './lib/nativeUsageSqlRehearsal.js';
import { NATIVE_USAGE_SNAPSHOT_TABLES } from './lib/nativeUsageSnapshot.js';
import { scanDatabaseMigrationFiles, scanMigrationFiles } from './lib/migrationFiles.js';
import { fileURLToPath } from 'node:url';
import { sqlDump, sqlFixture, schemaSqlDump } from './lib/nativeUsageSqlRehearsal.testFixture.js';

// Generate real pg_dump output using fixed synthetic SQL only. Nothing from a
// snapshot is executed by this privileged fixture builder or mounted into it.
function actualDump(directory) {
  const name = `portos-native-rehearsal-fixture-${randomBytes(12).toString('hex')}`;
  const docker = (args, input = '') => execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', '--config', directory, ...args],
    { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory }, input, encoding: 'utf8', timeout: 60000, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const seed = 'CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;\n'
    + NATIVE_USAGE_SNAPSHOT_TABLES.map(table => `CREATE TABLE public.${table} (id text PRIMARY KEY);\nCOPY public.${table} (id) FROM stdin;\nexample-row\n\\.\n`).join('')
    + `ALTER TABLE public.memories ADD COLUMN embedding vector(3), ADD COLUMN nonce uuid DEFAULT gen_random_uuid();
       UPDATE public.memories SET embedding = '[1,2,3]';
       CREATE SCHEMA example_schema;
       CREATE TABLE example_schema.extra (id integer PRIMARY KEY);
       INSERT INTO example_schema.extra VALUES (1);
       CREATE FUNCTION public.example_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       CREATE TRIGGER example_before_update BEFORE UPDATE ON public.cos_agents FOR EACH ROW EXECUTE FUNCTION public.example_trigger();`;
  const script = 'umask 077; initdb -D /var/lib/postgresql/data -U fixture_admin --auth=trust --no-locale --encoding=UTF8 >/dev/null '
    + '&& pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log -o "-c listen_addresses= -c unix_socket_directories=/tmp -c shared_buffers=32MB" -w start >/dev/null '
    + '&& psql -X -q -v ON_ERROR_STOP=1 -h /tmp -U fixture_admin -d postgres >/dev/null '
    + '&& pg_dump -h /tmp -U fixture_admin -d postgres --no-owner --no-acl --no-comments --clean --if-exists --exclude-table-data=restore_receipts --exclude-table-data=media_assets';
  try {
    return docker(['run', '--rm', '-i', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--user', '999:999', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
      '--memory=1g', '--memory-swap=1g', '--cpus=1', '--log-driver=none',
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=768m,uid=999,gid=999,mode=0700',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777', '--entrypoint', '/bin/sh', NATIVE_USAGE_SQL_IMAGE, '-c', script], seed);
  } finally {
    try { docker(['rm', '--force', '--volumes', name]); } catch { /* --rm may already have removed it. */ }
    expect(docker(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']).trim()).toBe('');
  }
}

// The DB workflow invokes this suite explicitly with 1, outside the test memo.
// Missing Docker/image/auth is then a failure, never a skipped real-replay claim.
describe.skipIf(process.env.PORTOS_NATIVE_SQL_LIVE !== '1')('real network-disabled SQL rehearsal', () => {
  let directory;
  const containers = () => execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', '--config', directory,
    'container', 'ls', '--all', '--filter', 'name=^/portos-native-rehearsal-', '--format', '{{.ID}}'],
  { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory }, encoding: 'utf8', timeout: 15000 }).trim();
  let before;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sql-rehearsal-live-'));
    before = containers();
  });
  afterEach(async () => {
    try { expect(containers()).toBe(before); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('replays standard clean pg_dump-shaped DDL/COPY and verifies committed rows before cleanup', async () => {
    const fixture = await sqlFixture(directory, sqlDump(`DO $$ BEGIN
      IF current_user <> 'rehearsal_restore' OR (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
      THEN RAISE EXCEPTION 'replay role is privileged'; END IF;
    END $$;`));
    const original = await readFile(join(directory, 'portos-db.sql'));
    let stdout = '';
    const code = await runNativeUsageRehearsalCli(fixture.args, { stdout: value => { stdout += value; } });
    const result = JSON.parse(stdout);
    expect(code).toBe(3);
    expect(result).toMatchObject({ database: { restoreVerified: true, requiredTablesQueryable: true,
      restoredRowCounts: { memories: '1', cos_agents: '1', schema_migrations: '1' }, sourceRowCountsMatched: false, schemaAndMigrationsMatched: false },
      isolation: { image: NATIVE_USAGE_SQL_IMAGE, containerRemoved: true }, activationReady: false, fullRecoveryBackup: false });
    expect(await readFile(join(directory, 'portos-db.sql'))).toEqual(original);
    expect(stdout).not.toContain('example-row');
  }, 120000);

  it('accepts actual production-flag pg_dump output with extensions, another schema, a function and trigger', async () => {
    const dump = actualDump(directory);
    expect(dump).toContain('CREATE FUNCTION');
    expect(dump).toContain('CREATE TRIGGER');
    expect(dump).toContain('CREATE SCHEMA');
    expect(dump).toContain('COPY public.memories');
    const fixture = await sqlFixture(directory, dump);
    let stdout = '';
    expect(await runNativeUsageRehearsalCli(fixture.args, { stdout: value => { stdout += value; } })).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({ database: { restoreVerified: true,
      restoredRowCounts: Object.fromEntries(NATIVE_USAGE_SNAPSHOT_TABLES.map(name => [name, '1'])),
      schemaAndMigrationsMatched: false }, isolation: { containerRemoved: true }, activationReady: false });
    expect(stdout).not.toContain('example-row');
  }, 180000);


  it('binds the executing committed code and both migration inventories to a restored startup-schema probe', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const codeCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const fileMigrationIds = await scanMigrationFiles(join(root, 'scripts/migrations'));
    const databaseIds = await scanDatabaseMigrationFiles(join(root, 'server/scripts/db-migrations'));
    const fixture = await sqlFixture(directory, schemaSqlDump(databaseIds), { codeCommit, fileMigrationIds });
    fixture.args[0] = 'schema-restore';
    let stdout = '';
    expect(await runNativeUsageRehearsalCli(fixture.args, { stdout: value => { stdout += value; } })).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({ code: { commit: codeCommit, installedDependenciesVerified: false, matchedRuntimeVerified: false },
      schemaProbe: { contract: 'maintenance-target-v1', verified: true, databaseMigrationInventoryMatched: true,
        fullSchemaVerified: false, applicationReadersVerified: false, migrationEffectsVerified: false },
      fileMigrations: { inventoryMatched: true, appliedStateVerified: false },
      database: { schemaAndMigrationsMatched: false }, fullRecoveryBackup: false, activationReady: false });
    expect(stdout).not.toContain('example-row');
  }, 180000);

  it.each([
    ['missing startup column', 'ALTER TABLE public.memories DROP COLUMN sync_sequence;', 'maintenance-schema-probe-mismatch'],
    ['hidden migration ID', `INSERT INTO public.schema_migrations(id) VALUES ('999999-hidden.sql');
      ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.schema_migrations FORCE ROW LEVEL SECURITY;
      CREATE POLICY hide_unknown ON public.schema_migrations FOR SELECT USING (id <> '999999-hidden.sql');`,
      'sql-rehearsal-command-failed:migration-inventory:permission-denied'],
    ['unknown migration ID', "INSERT INTO public.schema_migrations (id) VALUES ('999999-unknown.sql');", 'database-migration-inventory-mismatch'],
  ])('refuses %s in the real restored database and still removes its container', async (_label, extra, reason) => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const codeCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const fileMigrationIds = await scanMigrationFiles(join(root, 'scripts/migrations'));
    const databaseIds = await scanDatabaseMigrationFiles(join(root, 'server/scripts/db-migrations'));
    const fixture = await sqlFixture(directory, schemaSqlDump(databaseIds, extra), { codeCommit, fileMigrationIds });
    fixture.args[0] = 'schema-restore';
    let stdout = '';
    await expect(runNativeUsageRehearsalCli(fixture.args, { stdout: value => { stdout += value; } })).rejects.toThrow(reason);
    expect(stdout).toBe('');
  }, 180000);

  it.each([
    ['SQL privilege escalation', 'SET ROLE rehearsal_admin;', 'sql-rehearsal-command-failed:replay:permission-denied'],
    ['server command execution', "COPY (SELECT 1) TO PROGRAM 'id';", 'sql-rehearsal-command-failed:replay:permission-denied'],
    ['psql reconnect to admin', '\\connect postgres rehearsal_admin', 'snapshot-database-replay-mismatch'],
    ['psql shell escape', '\\! cat /var/lib/postgresql/data/pg_hba.conf', 'snapshot-database-replay-mismatch'],
    ['disabled dump restriction escape', '\\unrestrict exampleDumpKey\n\\! id', 'snapshot-database-replay-mismatch'],
    ['escape-mode ambiguity', String.raw`SET standard_conforming_strings = off;
SELECT '\'';
\quit
SELECT ';
`, 'snapshot-database-replay-mismatch'],
    ['dollar delimiter inside identifier', 'SELECT 1 AS foo$tag$;\n\\quit\nSELECT $tag$;\n', 'snapshot-database-replay-mismatch'],
    ['SQL error', 'SELECT 1/0;', 'sql-rehearsal-command-failed:replay:division-by-zero'],
  ])('rejects %s and removes its container without a receipt', async (_name, attack, reason) => {
    const fixture = await sqlFixture(directory, sqlDump(attack));
    let stdout = '';
    await expect(runNativeUsageRehearsalCli(fixture.args, { stdout: value => { stdout += value; } })).rejects.toThrow(reason);
    expect(stdout).toBe('');
  }, 120000);
});
