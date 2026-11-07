/** Disposable Linux Docker SQL replay. No install connections or runtime imports. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { refuseNativeUsageRehearsal as refuse } from '../../server/lib/nativeUsageRehearsal.js';
import { prepareDatabaseReplay } from '../../server/services/backupDatabaseDump.js';
import { newScratchDbName } from '../rehearsal-scratch-db.js';
import { NATIVE_USAGE_SNAPSHOT_TABLES, spoolNativeUsageSnapshotDatabase, verifyNativeUsageSnapshot } from './nativeUsageSnapshot.js';

export const NATIVE_USAGE_SQL_IMAGE = 'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d';
const MAX_SQL_BYTES = 256 * 1024 * 1024;
const ADMIN = 'rehearsal_admin';
const REPLAY = 'rehearsal_restore';
const AUTH_SHELL = 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec "$@"';
const INIT = 'umask 077; IFS= read -r password; printf "%s\\n" "$password" > /tmp/init-password; '
  + 'initdb -D /var/lib/postgresql/data -U rehearsal_admin --auth=scram-sha-256 --pwfile=/tmp/init-password --no-locale --encoding=UTF8 >/dev/null '
  + '&& rm /tmp/init-password && pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log '
  + '-o "-c listen_addresses= -c unix_socket_directories=/tmp -c max_connections=10 -c shared_buffers=32MB" -w start';
const PSQL = ['psql', '-X', '--no-password', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp'];
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
    let outputBytes = 0;
    let failed = false;
    let inputDone = Promise.resolve();
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      inputDone.then(() => {
        if (failed || signal?.aborted) reject(new Error('Native SQL rehearsal command failed or exceeded its limit'));
        else resolve({ code, stdout: stdout.trim() });
      }, () => reject(new Error('Native SQL rehearsal input failed')));
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) fail();
      else if (stream === child.stdout) stdout += chunk.toString();
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

async function replayInContainer(config, replayPath, signal) {
  const name = `portos-native-rehearsal-${randomBytes(12).toString('hex')}`;
  const database = newScratchDbName();
  const adminPassword = randomBytes(32).toString('hex');
  const restorePassword = randomBytes(32).toString('hex');
  const restriction = randomBytes(32).toString('hex');
  const completion = `native_rehearsal_end_${randomBytes(32).toString('hex')}`;
  const run = async (args, options = {}) => {
    const result = await docker(config, args, { signal, ...options });
    if (result.code !== 0) refuse('sql-rehearsal-command-failed');
    return result.stdout;
  };
  const psql = (user, password, target, content, args = []) => run([
    'exec', '-i', '--user', user === ADMIN ? '999:999' : '65534:65534', name,
    'sh', '-c', AUTH_SHELL, 'sh', ...PSQL, '-U', user, '-d', target, ...args,
  ], { input: authenticated(password, content), timeout: 15 * 60 * 1000 });
  let rows;
  let created = false;
  try {
    // Mark before the request: a disconnected create can still have succeeded.
    created = true;
    await run(['create', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--user', '999:999', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=64', '--memory=1g', '--memory-swap=1g', '--cpus=1', '--log-driver=none',
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=768m,uid=999,gid=999,mode=0700',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
      '--entrypoint', '/bin/sleep', NATIVE_USAGE_SQL_IMAGE, 'infinity']);
    await run(['start', name]);
    await run(['exec', '-i', '--user', '999:999', name, 'sh', '-c', INIT], { input: authenticated(adminPassword), timeout: 60000 });
    await psql(ADMIN, adminPassword, 'postgres', `CREATE ROLE ${REPLAY} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${restorePassword}';`);
    await psql(ADMIN, adminPassword, 'postgres', `CREATE DATABASE ${database} OWNER ${REPLAY};`);
    await psql(ADMIN, adminPassword, database, 'CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;');
    const restrictedInput = Readable.from((async function* () {
      yield `\\restrict ${restriction}\n`;
      for await (const chunk of createReadStream(replayPath)) yield chunk;
      yield `\n\\echo ${completion}\n`;
    })());
    const output = await psql(REPLAY, restorePassword, database, restrictedInput, ['--single-transaction', '-q']);
    // An exit code alone cannot distinguish a complete replay from psql's
    // successful early exit. This private unpredictable marker follows all
    // supplied bytes and is independent of the conservative lexical inspector.
    if (!output.split(/\r?\n/).includes(completion)) refuse('sql-rehearsal-input-end-not-reached');
    // Run new sessions after COMMIT. Only fixed table names/counts leave the
    // container; no source identifiers, migration ids, rows or SQL errors do.
    const tables = await psql(REPLAY, restorePassword, database, '', ['-At', '-c', tableSql]);
    if (tables !== String(NATIVE_USAGE_SNAPSHOT_TABLES.length)) refuse('sql-rehearsal-table-check-failed');
    rows = countRows(await psql(REPLAY, restorePassword, database, '', ['-At', '-c', rowCountSql]));
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
  return { rowCounts: rows, containerRemoved: true };
}

/** One detached snapshot, no arbitrary target or executable configuration. */
export async function rehearseNativeUsageSql(stage, backup, directory) {
  if (process.platform !== 'linux') refuse('sql-rehearsal-requires-isolated-linux-docker');
  const snapshot = await verifyNativeUsageSnapshot(stage, backup, directory);
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
    const restored = await replayInContainer(scratch, replay, abort.signal);
    return {
      ...snapshot, kind: 'native-usage-sql-rehearsal',
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
