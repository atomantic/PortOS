import { spawn } from '../lib/childProcess.js';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fsyncSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PATHS } from '../lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { snapshotProcesses } from '../lib/detachedSpawn.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { quiesceDatabaseWriters } from './databaseMaintenanceQuiescence.js';

const refused = (reason) => Object.assign(
  new Error(`Database transfer refused: ${reason}. Maintenance remains fenced.`),
  { code: 'DATABASE_TRANSFER' },
);

// pg_dump's plain-format completion marker. Newer releases may append an
// `\unrestrict` line after it, so only the tail is searched.
const DUMP_COMPLETE = '-- PostgreSQL database dump complete';
const TAIL_BYTES = 4096;

function syncPath(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Regular file only (never a symlink), with the bytes the manifest recorded.
async function dumpIdentity(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw refused('the recovery dump is not a regular file');
  return { bytes: stat.size, sha256: await digest(path) };
}

function hasCompletionMarker(path) {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').includes(DUMP_COMPLETE);
  } finally {
    closeSync(fd);
  }
}

/**
 * Run scripts/db.sh bound to ONE recorded endpoint. The environment is built
 * from an allowlist: inherited libpq variables (PGHOST, PGHOSTADDR, PGSERVICE,
 * PGOPTIONS, …) never reach it, and db.sh strips them again for explicit
 * endpoints. Children stay in this worker's process group so a successor can
 * prove none survive (assertPredecessorCoordinatorsStopped). Output is kept
 * internal: it can name hosts and paths.
 */
function runDbScript(action, endpoint, argument, dumpDir) {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? PATHS.installRoot,
    PGPASSWORD: process.env.PGPASSWORD || 'portos', PORTOS_DUMP_DIR: dumpDir, LC_ALL: 'C' };
  const args = [join(PATHS.root, 'scripts', 'db.sh'), action, '--endpoint',
    endpoint.host, String(endpoint.port), endpoint.user, endpoint.database, argument];
  return new Promise((resolve) => {
    const child = spawn('bash', args, { cwd: PATHS.root, env: withSpawnCwdEnv(env, PATHS.root), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
    child.once('error', () => resolve({ code: null, stdout: '' }));
    child.once('close', code => resolve({ code, stdout }));
  });
}

async function recordOwnGroup(journal, id, token) {
  if (process.platform === 'win32') return;
  const own = (await snapshotProcesses()).find(proc => proc.pid === process.pid)?.pgid;
  if (!Number.isSafeInteger(own) || own <= 0) throw refused('the coordinator process group is unknown');
  journal.recordCoordinatorGroup(id, token, own);
}

async function exportRecoveryDump(journal, id, token, operation) {
  const path = journal.transferDumpPath(id);
  journal.assertCoordinatorWorker(id, token);
  const result = await runDbScript('export', operation.source, basename(path, '.sql').slice('portos-'.length), dirname(path));
  journal.assertCoordinatorWorker(id, token);
  // A failed or incomplete export is never recorded, so it can never be
  // imported; the next attempt exports again after renewed quiescence.
  if (result.code !== 0) throw refused(`the source export failed (exit ${result.code ?? 'spawn'})`);
  if (result.stdout.trim().split('\n').at(-1) !== path) throw refused('the source export did not publish the recorded dump');
  if (!lstatSync(path).isFile() || !hasCompletionMarker(path)) throw refused('the source export is incomplete');
  syncPath(path);
  syncPath(dirname(path));
  const identity = await dumpIdentity(path);
  return journal.recordTransferDump(id, token, { id, source: operation.source, file: basename(path), ...identity });
}

async function assertRecordedDump(journal, id, dump) {
  const path = journal.transferDumpPath(id);
  let identity;
  try { identity = await dumpIdentity(path); } catch {
    throw refused('the recorded recovery dump is missing');
  }
  if (identity.bytes !== dump.bytes || identity.sha256 !== dump.sha256) {
    throw refused('the recovery dump no longer matches its recorded digest');
  }
  return path;
}

/**
 * Internal offline transfer for the one entered coordinator worker. It never
 * changes saved mode, restarts producers, or reopens admission: the result is
 * a committed target import at `importing`, awaiting verified restart (#8851).
 *
 * Every attempt (including a recovered successor) first repeats quiescence.
 * `exporting` without a recorded dump re-exports; a recorded dump is reused
 * only when its bytes still match. `importing` retries only the recorded dump
 * into the recorded target, in one transaction. Direction never changes.
 * `options` only shortens reconciliation waits for subprocess tests.
 */
export async function runDatabaseTransfer(id, token, options = {}) {
  const journal = createDatabaseMaintenanceJournal();
  const entered = journal.enterCoordinatorWorker(id, token);
  if (!['accepted', 'quiescing', 'exporting', 'importing'].includes(entered.stage)) {
    throw refused(`stage ${entered.stage} is not a transfer stage`);
  }
  await recordOwnGroup(journal, id, token);
  await quiesceDatabaseWriters(id, token, options);

  let operation = journal.assertEnteredCoordinatorWorker(id, token);
  if (operation.stage === 'quiescing') operation = journal.transition(id, token, 'quiescing', 'exporting');
  if (operation.stage === 'exporting') {
    const dump = journal.readTransferDump(id) ?? await exportRecoveryDump(journal, id, token, operation);
    await assertRecordedDump(journal, id, dump);
    operation = journal.transition(id, token, 'exporting', 'importing');
  }
  if (operation.stage !== 'importing') throw refused('the operation left the transfer stages');

  const dump = journal.readTransferDump(id);
  if (!dump) throw refused('no complete recovery dump is recorded');
  let imported = false;
  // A crash after the target commits but before the receipt publishes makes the
  // next attempt import the same --clean dump again. That retry is idempotent:
  // nothing can write the target before verified restart (#8851), which needs
  // this receipt, so it reproduces the identical committed state.
  if (!journal.readTransferImport(id)) {
    const path = await assertRecordedDump(journal, id, dump);
    journal.assertCoordinatorWorker(id, token);
    const result = await runDbScript('import', operation.target, path, dirname(path));
    journal.assertCoordinatorWorker(id, token);
    if (result.code !== 0) throw refused(`the target import failed and was rolled back (exit ${result.code ?? 'spawn'})`);
    journal.recordTransferImport(id, token, { id, target: operation.target, sha256: dump.sha256 });
    imported = true;
  }
  return { id, stage: 'importing', source: operation.source.mode, target: operation.target.mode,
    imported, importCommitted: true, sourceRetained: true, restartVerified: false };
}
