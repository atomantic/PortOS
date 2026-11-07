import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNativeUsageRehearsalCli } from '../native-usage-rehearse.js';
import { NATIVE_USAGE_SQL_IMAGE } from './nativeUsageSqlRehearsal.js';
import { pinPlatform } from '../../server/lib/testHelper.js';
import { NATIVE_USAGE_SNAPSHOT_TABLES, spoolNativeUsageSnapshotDatabase, verifyNativeUsageSnapshot } from './nativeUsageSnapshot.js';
import { verifyNativeUsageCode } from './nativeUsageCodeBinding.js';
import { DATABASE_MAINTENANCE_SCHEMA_SQL } from '../../server/lib/databaseMaintenanceSchema.js';
import { sqlDump, sqlFixture } from './nativeUsageSqlRehearsal.testFixture.js';

vi.mock('./nativeUsageCodeBinding.js', async original => ({ ...await original(), verifyNativeUsageCode: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original(), spawn: vi.fn() }));
let directory;
let calls;
let failWhen;
let leftover;
let transportFailure;
let restorePlatform;
let failureExitCode;
let failureStderr;
let schemaHealth;
let migrationIds;
const boundCode = { manifest: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), matchedRuntimeVerified: false,
  installedDependenciesVerified: false }, fileMigrationIds: ['001-example.js'], databaseMigrationIds: ['001-example.sql'] };
const rows = Object.fromEntries(NATIVE_USAGE_SNAPSHOT_TABLES.map(name => [name, '1']));
beforeEach(async () => {
  restorePlatform = pinPlatform('linux');
  schemaHealth = { has_memories: true, has_links: true, has_sync: true, has_catalog: true, has_catalog_scraps: true };
  migrationIds = boundCode.databaseMigrationIds;
  vi.mocked(verifyNativeUsageCode).mockReset().mockResolvedValue(boundCode);
  directory = await mkdtemp(join(tmpdir(), 'native-sql-test-'));
  calls = []; failWhen = () => false; leftover = false; transportFailure = null;
  failureExitCode = 1; failureStderr = 'private SQL, private database credentials';
  vi.mocked(spawn).mockImplementation((binary, argv, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const call = { binary, argv, options, input: '' }; calls.push(call);
    child.stdin.on('data', chunk => {
      call.input += chunk.toString();
      if (transportFailure === 'stdin' && argv.includes('--single-transaction')) {
        child.stdin.destroy(new Error('private stdin error'));
        setImmediate(() => child.emit('close', 1));
      }
    });
    child.stdin.on('finish', () => {
      setImmediate(() => {
        const failed = failWhen(call);
        const sql = argv.at(-1);
        let output = argv.includes('--single-transaction') && transportFailure !== 'early-exit'
          ? call.input.match(/\nSELECT '(native_rehearsal_end_[a-f0-9]+)';\n$/)?.[1] ?? '' : '';
        if (sql.includes('row_to_json(probe)')) output = JSON.stringify({ database: argv[argv.indexOf('-d') + 1], user: 'rehearsal_restore', ...schemaHealth });
        else if (sql.includes('json_agg(id')) output = JSON.stringify(migrationIds);
        else if (sql.includes('json_build_object')) output = JSON.stringify(rows);
        else if (sql.includes('pg_class')) output = String(NATIVE_USAGE_SNAPSHOT_TABLES.length);
        if (argv.includes('ls') && leftover) output = 'synthetic-container-id';
        if (argv.includes('--single-transaction')) {
          if (transportFailure === 'interrupt') process.emit('SIGTERM');
          if (transportFailure === 'spawn') child.emit('error', new Error('private spawn error'));
          if (transportFailure === 'output') child.stdout.write('x'.repeat(1024 * 1024 + 1));
        }
        if (failed) child.stderr.write(failureStderr);
        else child.stdout.write(output);
        child.stdout.end(); child.stderr.end(); child.emit('close', failed ? failureExitCode : 0);
      });
    });
    return child;
  });
});
afterEach(async () => { restorePlatform(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
async function run(args) {
  let output = '';
  const code = await runNativeUsageRehearsalCli(args, { stdout: value => { output += value; } });
  return { code, result: JSON.parse(output), output };
}

describe('SQL rehearsal CLI isolation and evidence contract (synthetic Docker transport)', () => {
  it('binds exact dump bytes, restricts replay and cleans up before reporting SQL-only evidence', async () => {
    const fixture = await sqlFixture(directory);
    vi.stubEnv('PGHOST', 'private-db.invalid'); vi.stubEnv('DOCKER_HOST', 'tcp://private-daemon.invalid');
    vi.stubEnv('DOCKER_CONTEXT', 'private-context'); vi.stubEnv('PGPASSWORD', 'private-secret');
    const before = await readFile(join(directory, 'portos-db.sql'));
    const { code, result, output } = await run(fixture.args);
    expect(code).toBe(3);
    expect(result).toMatchObject({ stageHash: fixture.stage.contentHash, backupHash: fixture.backup.contentHash,
      database: { restoreVerified: true, schemaAndMigrationsMatched: false, sourceRowCountsMatched: false, restoredRowCounts: rows, omittedRanges: 4 },
      fullStoreInventoryVerified: false, fullRecoveryBackup: false, activationReady: false,
      isolation: { image: NATIVE_USAGE_SQL_IMAGE, replaySuperuser: false, separateReplayOsIdentity: true, containerRemoved: true } });
    expect(result.holdReasons).not.toContain('database-restore-not-verified');
    expect(result.holdReasons).toContain('matched-runtime-restore-not-verified');
    expect(await readFile(join(directory, 'portos-db.sql'))).toEqual(before);
    const create = calls.find(call => call.argv.includes('create'));
    expect(create.argv).toEqual(expect.arrayContaining(['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '999:999', '--pids-limit=64', '--memory=1g', '--cpus=1']));
    expect(create.argv.join(' ')).not.toMatch(/--(?:volume|publish|privileged|device|mount)(?:=| )/);
    for (const call of calls) {
      expect(call.binary).toBe('/usr/bin/docker');
      expect(call.argv.slice(0, 3)).toEqual(['--host', 'unix:///var/run/docker.sock', '--config']);
      expect(call.options.env).toEqual({ PATH: '/usr/bin:/bin', HOME: call.options.cwd });
      expect(call.options.shell).toBe(false);
    }
    const replay = calls.find(call => call.argv.includes('--single-transaction'));
    expect(replay.argv).toEqual(expect.arrayContaining(['65534:65534', '-X', '--no-password', 'ON_ERROR_STOP=1', 'rehearsal_restore']));
    expect(replay.input).toMatch(/^[a-f0-9]{64}\n\\restrict [a-f0-9]{64}\n/);
    expect(replay.argv.slice(-5)).toEqual(['--single-transaction', '-q', '-At', '-f', '-']);
    expect(replay.argv).toContain('VERBOSITY=sqlstate');
    expect(replay.input).toMatch(/\nSELECT 'native_rehearsal_end_[a-f0-9]{64}';\n$/);
    expect(replay.input).not.toContain('\\echo');
    expect(replay.input).not.toContain('\\unrestrict');
    expect(replay.input).not.toContain('exampleDumpKey');
    expect(replay.input).not.toContain('DROP EXTENSION');
    expect(replay.input).not.toContain('COMMENT ON EXTENSION');
    expect(calls.some(call => call.input.includes('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'))).toBe(true);
    expect(calls.at(-2).argv).toContain('--force');
    expect(calls.at(-1).argv).toContain('ls');
    expect(output).not.toMatch(/private-|example-row|native-sql-test-/);
  });

  it('refuses non-Linux callers before any snapshot or daemon access', async () => {
    const fixture = await sqlFixture(directory);
    const restore = pinPlatform('darwin');
    try { await expect(run(fixture.args)).rejects.toThrow('sql-rehearsal-requires-isolated-linux-docker'); }
    finally { restore(); }
    expect(calls).toHaveLength(0);
  });

  it('rechecks the SQL hash while spooling instead of trusting a previous inspection', async () => {
    const fixture = await sqlFixture(directory);
    const snapshot = await verifyNativeUsageSnapshot(fixture.stage, fixture.backup, directory);
    const path = join(directory, 'portos-db.sql');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replaceAll('example-row', 'changed-row'));
    await expect(spoolNativeUsageSnapshotDatabase(directory, snapshot.database, join(directory, 'spool.sql'))).rejects.toThrow('snapshot-database-replay-mismatch');
    expect(calls).toHaveLength(0);
  });

  it.each(['interrupt', 'spawn', 'output', 'stdin'])('cleans up after a transport %s without publishing a receipt', async mode => {
    const fixture = await sqlFixture(directory);
    transportFailure = mode;
    let output = '';
    await expect(runNativeUsageRehearsalCli(fixture.args, { stdout: value => { output += value; } })).rejects.toThrow('Native SQL rehearsal');
    expect(output).toBe('');
    expect(calls.at(-2).argv).toContain('--force');
    expect(calls.at(-1).argv).toContain('ls');
    expect(calls.at(-1).options.signal).toBeUndefined();
  });

  it('requires the unpredictable end marker even when psql exits zero and query checks would pass', async () => {
    const fixture = await sqlFixture(directory);
    transportFailure = 'early-exit';
    await expect(run(fixture.args)).rejects.toThrow('sql-rehearsal-input-end-not-reached');
    expect(calls.some(call => call.argv.at(-1).includes('pg_class'))).toBe(false);
    expect(calls.at(-1).argv).toContain('ls');
  });

  it.each(['\\quit', '\\if false\nSELECT 1;\n\\endif'])('refuses psql control flow %s before Docker rather than claiming a partial replay', async command => {
    const fixture = await sqlFixture(directory, sqlDump(command));
    await expect(run(fixture.args)).rejects.toThrow('snapshot-database-replay-mismatch');
    expect(calls).toHaveLength(0);
  });

  it('refuses corruption before contacting Docker', async () => {
    const fixture = await sqlFixture(directory);
    await writeFile(join(directory, 'portos-db.sql'), 'changed');
    await expect(run(fixture.args)).rejects.toThrow('snapshot-file-hash-mismatch');
    expect(calls).toHaveLength(0);
  });

  it.each(['create', 'start', 'replay', 'check'])('cleans up a failed %s without exposing SQL output or issuing a receipt', async stage => {
    const fixture = await sqlFixture(directory);
    failWhen = call => stage === 'replay' ? call.argv.includes('--single-transaction')
      : stage === 'check' ? call.argv.at(-1).includes('pg_class') : call.argv.includes(stage);
    await expect(run(fixture.args)).rejects.toThrow('sql-rehearsal-command-failed');
    expect(calls.at(-2).argv).toContain('--force');
    expect(calls.at(-1).argv).toContain('ls');
  });

  it.each([
    [1, 'client-error', 'private client details'],
    [2, 'connection-error', 'private connection details'],
    [3, 'permission-denied', 'psql:<stdin>:2: ERROR:  42501\nDETAIL: private SQL and secrets'],
    [3, 'division-by-zero', 'psql:<stdin>:3: ERROR:  22012\n'],
    [3, 'script-error', 'psql:<stdin>:4: ERROR:  P0001\nprivate exception text'],
  ])('classifies replay exit %s as %s without returning raw diagnostics', async (code, category, diagnostic) => {
    const fixture = await sqlFixture(directory);
    failWhen = call => call.argv.includes('--single-transaction');
    failureExitCode = code; failureStderr = diagnostic;
    const error = await run(fixture.args).catch(value => value);
    expect(error.message).toBe(`Native usage rehearsal refused: sql-rehearsal-command-failed:replay:${category}`);
    expect(error.message).not.toMatch(/private|stdin|42501|22012|P0001/);
    expect(calls.at(-1).argv).toContain('ls');
  });

  it('classifies a post-replay -c SQL failure even though psql returns exit one', async () => {
    const fixture = await sqlFixture(directory);
    failWhen = call => call.argv.at(-1).includes('json_build_object');
    failureExitCode = 1; failureStderr = 'ERROR:  42501\nprivate relation details';
    await expect(run(fixture.args)).rejects.toThrow('sql-rehearsal-command-failed:count-rows:permission-denied');
    expect(calls.at(-1).argv).toContain('ls');
  });

  it('withholds success on leftover containers and an unreachable cleanup verification', async () => {
    const fixture = await sqlFixture(directory);
    leftover = true;
    await expect(run(fixture.args)).rejects.toThrow('sql-rehearsal-cleanup-unverified');
    leftover = false; failWhen = call => call.argv.includes('ls');
    await expect(run(fixture.args)).rejects.toThrow('sql-rehearsal-cleanup-unverified');
  });
});


describe('matched code and restored maintenance-schema CLI boundary', () => {
  async function schemaFixture() {
    const fixture = await sqlFixture(directory, sqlDump(), { fileMigrationIds: boundCode.fileMigrationIds });
    fixture.args[0] = 'schema-restore';
    return fixture;
  }

  it('uses the actual startup query in a read-only transaction and leaves all full-runtime holds', async () => {
    const fixture = await schemaFixture();
    const { code, result } = await run(fixture.args);
    expect(code).toBe(3);
    expect(result).toMatchObject({ kind: 'native-usage-schema-rehearsal', code: boundCode.manifest,
      schemaProbe: { contract: 'maintenance-target-v1', verified: true, readOnly: true, fullSchemaVerified: false,
        applicationReadersVerified: false, databaseMigrationInventoryMatched: true, migrationEffectsVerified: false },
      fileMigrations: { matchedToCode: true, inventoryMatched: true, appliedStateVerified: false, migrationEffectsVerified: false },
      database: { schemaAndMigrationsMatched: false }, activationReady: false, fullRecoveryBackup: false });
    expect(result.holdReasons).toContain('matched-code-schema-and-migrations-not-verified');
    expect(result.holdReasons).toContain('matched-runtime-restore-not-verified');
    const probe = calls.find(call => call.argv.at(-1).includes('row_to_json(probe)')).argv.at(-1);
    expect(probe).toContain(DATABASE_MAINTENANCE_SCHEMA_SQL);
    expect(probe).toMatch(/^BEGIN READ ONLY; SET LOCAL search_path = pg_catalog;/);
    expect(probe).toContain('SET LOCAL row_security = off;');
    expect(probe).toMatch(/ROLLBACK;$/);
    expect(verifyNativeUsageCode).toHaveBeenCalledTimes(2);
    expect(verifyNativeUsageCode).toHaveBeenCalledWith(fixture.backup.request.codeCommit);
  });

  it('refuses an unverified code binding before reading the snapshot or starting Docker', async () => {
    const fixture = await schemaFixture();
    vi.mocked(verifyNativeUsageCode).mockRejectedValue(new Error('code-commit-mismatch'));
    await expect(run(fixture.args)).rejects.toThrow('code-commit-mismatch');
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, [], ['999-unknown.js'], ['../001-example.js'], ['001-example.js', '001-example.js']].map(ids => [ids]))('refuses missing, pending, unknown, malformed or duplicate file migration state (%j)', async ids => {
    const fixture = await sqlFixture(directory, sqlDump(), { fileMigrationIds: ids });
    fixture.args[0] = 'schema-restore';
    await expect(run(fixture.args)).rejects.toThrow(/migration/);
    expect(calls).toHaveLength(0);
  });

  it.each([[], ['999-unknown.sql'], ['001-example.sql', '001-example.sql'], [null], [' 001-example.sql']].map(ids => [ids]))('refuses nonmatching restored database migration IDs (%j)', async ids => {
    const fixture = await schemaFixture();
    migrationIds = ids;
    await expect(run(fixture.args)).rejects.toThrow('database-migration-inventory-mismatch');
    expect(calls.at(-1).argv).toContain('ls');
  });

  it('does not upgrade a SQL replay into schema evidence when the actual startup predicate fails', async () => {
    const fixture = await schemaFixture();
    schemaHealth.has_sync = false;
    await expect(run(fixture.args)).rejects.toThrow('maintenance-schema-probe-mismatch');
    expect(calls.some(call => call.argv.at(-1).includes('json_agg(id'))).toBe(false);
    expect(calls.at(-1).argv).toContain('ls');
  });

  it('refuses a new current ledger appearing after a legacy-ledger snapshot was inspected', async () => {
    const fixture = await schemaFixture();
    await mkdir(join(directory, 'data', 'migrations'));
    await rename(join(directory, 'data', 'migrations.applied.json'), join(directory, 'data', 'migrations', '.applied.json'));
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files['migrations/.applied.json'] = manifest.files['migrations.applied.json'];
    delete manifest.files['migrations.applied.json'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    vi.mocked(verifyNativeUsageCode).mockResolvedValueOnce(boundCode).mockImplementationOnce(async () => {
      await writeFile(join(directory, 'data', 'migrations.applied.json'), JSON.stringify(boundCode.fileMigrationIds));
      return boundCode;
    });
    await expect(run(fixture.args)).rejects.toThrow('snapshot-migration-ledger-changed');
    expect(calls.at(-1).argv).toContain('ls');
  });

  it('withholds a receipt if code changes while replaying even after successful cleanup', async () => {
    const fixture = await schemaFixture();
    vi.mocked(verifyNativeUsageCode).mockResolvedValueOnce(boundCode).mockResolvedValueOnce({ ...boundCode, manifest: { ...boundCode.manifest, tree: 'c'.repeat(40) } });
    await expect(run(fixture.args)).rejects.toThrow('code-input-changed');
    expect(calls.at(-1).argv).toContain('ls');
  });
});
