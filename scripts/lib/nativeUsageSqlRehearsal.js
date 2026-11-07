/** Disposable Linux Docker SQL replay. No install connections or runtime imports. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATABASE_MAINTENANCE_SCHEMA_CONTRACT, DATABASE_MAINTENANCE_SCHEMA_SQL, databaseMaintenanceSchemaHealthy } from '../../server/lib/databaseMaintenanceSchema.js';
import { nativeUsageCanonicalJson } from '../../server/lib/nativeUsageContract.js';
import { refuseNativeUsageRehearsal as refuse } from '../../server/lib/nativeUsageRehearsal.js';
import { prepareDatabaseReplay } from '../../server/services/backupDatabaseDump.js';
import { newScratchDbName } from '../rehearsal-scratch-db.js';
import { assertNativeUsageMigrationIds, verifyNativeUsageCode } from './nativeUsageCodeBinding.js';
import { NATIVE_USAGE_SNAPSHOT_TABLES, readNativeUsageSnapshotMigrations, spoolNativeUsageSnapshotDatabase, verifyNativeUsageSnapshot } from './nativeUsageSnapshot.js';

export const NATIVE_USAGE_SQL_IMAGE = 'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d';
const MAX_SQL_BYTES = 256 * 1024 * 1024;
const ADMIN = 'rehearsal_admin';
const REPLAY = 'rehearsal_restore';
const AUTH_SHELL = 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec "$@"';
const INIT = 'umask 077; IFS= read -r password; printf "%s\\n" "$password" > /tmp/init-password; '
  + 'initdb -D /var/lib/postgresql/data -U rehearsal_admin --auth=scram-sha-256 --pwfile=/tmp/init-password --no-locale --encoding=UTF8 >/dev/null '
  + '&& rm /tmp/init-password && pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log '
  + '-o "-c listen_addresses= -c unix_socket_directories=/tmp -c max_connections=10 -c shared_buffers=32MB" -w start';
const PSQL = ['psql', '-X', '--no-password', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-h', '/tmp'];
const SQL_FAILURES = { '42501': 'permission-denied', '42601': 'sql-syntax', '42P01': 'missing-table', '42704': 'missing-object', '22012': 'division-by-zero', '0A000': 'unsupported-sql' };
const rowCountSql = `SELECT pg_catalog.json_build_object(${NATIVE_USAGE_SNAPSHOT_TABLES.map(name => `'${name}', (SELECT count(*)::text FROM public.${name})`).join(',')});`;
const tableSql = `SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname IN (${NATIVE_USAGE_SNAPSHOT_TABLES.map(name => `'${name}'`).join(',')});`;

// The Docker CLI receives no inherited environment/config/context. Its only
// endpoint is the local Linux daemon; nothing from the host is mounted inside.
function docker(config, args, { input, signal, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', '--config', config, ...args], {
      cwd: config, env: { PATH: '/usr/bin:/bin', HOME: config }, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], signal, timeout, killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failed = false;
    let inputDone = Promise.resolve();
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      inputDone.then(() => {
        if (failed || signal?.aborted) reject(new Error('Native SQL rehearsal command failed or exceeded its limit'));
        else resolve({ code, stdout: stdout.trim(), sqlFailure: SQL_FAILURES[stderr.match(/\b(?:ERROR|FATAL):\s+([A-Z0-9]{5})\s*$/m)?.[1]] });
      }, () => reject(new Error('Native SQL rehearsal input failed')));
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) fail();
      else if (stream === child.stdout) stdout += chunk.toString();
      else stderr += chunk.toString();
    });
    inputDone = pipeline(input ?? Readable.from([]), child.stdin).catch(() => { fail(); });
  });
}

function authenticated(password, content = '') {
  return Readable.from((async function* () {
    yield `${password}\n`;
    if (typeof content === 'string') yield content;
    else for await (const chunk of content) yield chunk;
  })());
}

function countRows(value) {
  let rows;
  try { rows = JSON.parse(value); } catch { refuse('sql-rehearsal-row-check-failed'); }
  if (!rows || Object.keys(rows).length !== NATIVE_USAGE_SNAPSHOT_TABLES.length
    || NATIVE_USAGE_SNAPSHOT_TABLES.some(name => typeof rows[name] !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(rows[name]))) refuse('sql-rehearsal-row-check-failed');
  return rows;
}

async function replayInContainer(config, replayPath, signal, code) {
  const name = `portos-native-rehearsal-${randomBytes(12).toString('hex')}`;
  const database = newScratchDbName();
  const adminPassword = randomBytes(32).toString('hex');
  const restorePassword = randomBytes(32).toString('hex');
  const restriction = randomBytes(32).toString('hex');
  const completion = `native_rehearsal_end_${randomBytes(32).toString('hex')}`;
  const run = async (args, { phase, sql = false, ...options } = {}) => {
    const result = await docker(config, args, { signal, ...options });
    if (result.code !== 0) {
      // Only fixed categories leave this boundary. Raw SQL/client diagnostics
      // can contain rows, identifiers, paths and secrets, even on failure.
      const category = !sql ? 'process-error' : result.code === 2 ? 'connection-error'
        : result.code === 1 || result.code === 3 ? result.sqlFailure ?? (result.code === 1 ? 'client-error' : 'script-error') : 'process-error';
      refuse(`sql-rehearsal-command-failed:${phase}:${category}`);
    }
    return result.stdout;
  };
  const psql = (phase, user, password, target, content, args = []) => run([
    'exec', '-i', '--user', user === ADMIN ? '999:999' : '65534:65534', name,
    'sh', '-c', AUTH_SHELL, 'sh', ...PSQL, '-U', user, '-d', target, ...args,
  ], { phase, sql: true, input: authenticated(password, content), timeout: 15 * 60 * 1000 });
  let rows;
  let schemaProbe;
  let created = false;
  try {
    // Mark before the request: a disconnected create can still have succeeded.
    created = true;
    await run(['create', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--user', '999:999', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=64', '--memory=1g', '--memory-swap=1g', '--cpus=1', '--log-driver=none',
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=768m,uid=999,gid=999,mode=0700',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
      '--entrypoint', '/bin/sleep', NATIVE_USAGE_SQL_IMAGE, 'infinity'], { phase: 'create' });
    await run(['start', name], { phase: 'start' });
    await run(['exec', '-i', '--user', '999:999', name, 'sh', '-c', INIT], { phase: 'initialize', input: authenticated(adminPassword), timeout: 60000 });
    await psql('create-role', ADMIN, adminPassword, 'postgres', `CREATE ROLE ${REPLAY} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${restorePassword}';`);
    await psql('create-database', ADMIN, adminPassword, 'postgres', `CREATE DATABASE ${database} OWNER ${REPLAY};`);
    await psql('install-extensions', ADMIN, adminPassword, database, 'CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;');
    const restrictedInput = Readable.from((async function* () {
      yield `\\restrict ${restriction}\n`;
      for await (const chunk of createReadStream(replayPath)) yield chunk;
      yield `\nSELECT '${completion}';\n`;
    })());
    const output = await psql('replay', REPLAY, restorePassword, database, restrictedInput, ['--single-transaction', '-q', '-At', '-f', '-']);
    // Restricted psql rejects every meta-command except unrestrict, including
    // echo. A SQL result proves the end of supplied input without relaxing that
    // boundary; -At makes the private unpredictable token an exact output line.
    if (!output.split(/\r?\n/).includes(completion)) refuse('sql-rehearsal-input-end-not-reached');
    // Run new sessions after COMMIT. Only fixed table names/counts leave the
    // container; no source identifiers, migration ids, rows or SQL errors do.
    const tables = await psql('verify-tables', REPLAY, restorePassword, database, '', ['-At', '-c', tableSql]);
    if (tables !== String(NATIVE_USAGE_SNAPSHOT_TABLES.length)) refuse('sql-rehearsal-table-check-failed');
    rows = countRows(await psql('count-rows', REPLAY, restorePassword, database, '', ['-At', '-c', rowCountSql]));
    if (code) {
      // The same SELECT and predicate used before the application graph is
      // imported by server/start.js. Only these recorded probes are claimed.
      const readOnly = sql => `BEGIN READ ONLY; SET LOCAL search_path = pg_catalog; SET LOCAL row_security = off; ${sql}; ROLLBACK;`;
      const value = await psql('maintenance-schema', REPLAY, restorePassword, database, '', ['-qAt', '-c',
        readOnly(`SELECT pg_catalog.row_to_json(probe) FROM (${DATABASE_MAINTENANCE_SCHEMA_SQL}) probe`)]);
      let health;
      try { health = JSON.parse(value); } catch { refuse('maintenance-schema-probe-invalid'); }
      if (health?.database !== database || health?.user !== REPLAY || !databaseMaintenanceSchemaHealthy(health)) refuse('maintenance-schema-probe-mismatch');
      const recorded = await psql('migration-inventory', REPLAY, restorePassword, database, '', ['-qAt', '-c',
        readOnly(`SELECT COALESCE(pg_catalog.json_agg(id ORDER BY id), '[]'::json) FROM (SELECT id FROM public.schema_migrations LIMIT ${code.databaseMigrationIds.length + 1}) recorded`)]);
      let ids;
      try { ids = JSON.parse(recorded); } catch { refuse('database-migration-inventory-invalid'); }
      assertNativeUsageMigrationIds(ids, code.databaseMigrationIds, 'database');
      schemaProbe = { contract: DATABASE_MAINTENANCE_SCHEMA_CONTRACT,
        querySha256: createHash('sha256').update(DATABASE_MAINTENANCE_SCHEMA_SQL).digest('hex'),
        scope: 'memory-catalog-presence-and-memory-sync-column', verified: true, readOnly: true,
        fullSchemaVerified: false, applicationReadersVerified: false,
        databaseMigrationInventoryMatched: true, recordedDatabaseMigrations: ids.length, migrationEffectsVerified: false };
    }

  } finally {
    if (created) {
      // Cleanup owns a fresh budget even after interruption/timeout. Success
      // requires a working daemon to affirm absence, not an inspect error.
      await docker(config, ['rm', '--force', '--volumes', name]).catch(() => {});
      const remaining = await docker(config, ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])
        .catch(() => refuse('sql-rehearsal-cleanup-unverified'));
      if (remaining.code !== 0 || remaining.stdout) refuse('sql-rehearsal-cleanup-unverified');
    }
  }
  return { rowCounts: rows, containerRemoved: true, ...(schemaProbe ? { schemaProbe } : {}) };
}

/** One detached snapshot, no arbitrary target or executable configuration. */
export async function rehearseNativeUsageSql(stage, backup, directory, { verifySchema = false } = {}) {
  if (process.platform !== 'linux') refuse('sql-rehearsal-requires-isolated-linux-docker');
  const code = verifySchema ? await verifyNativeUsageCode(backup.request.codeCommit) : null;
  const snapshot = await verifyNativeUsageSnapshot(stage, backup, directory);
  if (code) assertNativeUsageMigrationIds(await readNativeUsageSnapshotMigrations(directory, snapshot.fileMigrations), code.fileMigrationIds, 'file');
  if (snapshot.database.bytes > MAX_SQL_BYTES) refuse('sql-rehearsal-dump-too-large');
  const scratch = await mkdtemp(join(tmpdir(), 'native-usage-sql-'));
  const abort = new AbortController();
  const stop = () => abort.abort();
  const timeout = setTimeout(stop, 15 * 60 * 1000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const spool = join(scratch, 'dump.sql');
    const checked = await spoolNativeUsageSnapshotDatabase(directory, snapshot.database, spool);
    const replay = await prepareDatabaseReplay(spool, checked.extensionMetadata);
    const restored = await replayInContainer(scratch, replay, abort.signal, code);
    if (code) {
      const after = await verifyNativeUsageCode(backup.request.codeCommit);
      if (nativeUsageCanonicalJson(after) !== nativeUsageCanonicalJson(code)) refuse('code-input-changed');
      assertNativeUsageMigrationIds(await readNativeUsageSnapshotMigrations(directory, snapshot.fileMigrations), code.fileMigrationIds, 'file');
    }
    return {
      ...snapshot, kind: code ? 'native-usage-schema-rehearsal' : 'native-usage-sql-rehearsal',
      ...(code ? { code: code.manifest, schemaProbe: restored.schemaProbe,
        fileMigrations: { ...snapshot.fileMigrations, matchedToCode: true, inventoryMatched: true,
          recordedMigrations: code.fileMigrationIds.length, migrationEffectsVerified: false } } : {}),
      database: { ...snapshot.database, restoreVerified: true,
        restoreScope: 'disposable-container-sql-replay', requiredTablesQueryable: true,
        restoredRowCounts: restored.rowCounts, sourceRowCountsMatched: false,
        replayTransform: 'omit-extension-metadata-and-version-directives', omittedRanges: checked.extensionMetadata.length },
      isolation: { image: NATIVE_USAGE_SQL_IMAGE, network: 'none', hostMounts: false,
        replaySuperuser: false, separateReplayOsIdentity: true, containerRemoved: restored.containerRemoved },
      holdReasons: snapshot.holdReasons.filter(reason => reason !== 'database-restore-not-verified'),
    };
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await rm(scratch, { recursive: true, force: true });
  }
}
