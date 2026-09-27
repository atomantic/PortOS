import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { PATHS } from '../lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { isDisposableRoot } from '../lib/dataRoot.js';
import { runDatabaseTransfer } from './databaseMaintenanceTransfer.js';
import { readRecordedProducers } from './databaseMaintenanceProducers.js';
import { restartMaintenanceProducer } from './pm2.js';

const TRANSFER_STAGES = ['accepted', 'quiescing', 'exporting', 'importing'];
const PROOF_TIMEOUT_MS = 180_000;
const POLL_MS = 250;

const refused = (reason) => Object.assign(
  new Error(`Database cutover refused: ${reason}. Maintenance remains fenced.`),
  { code: 'DATABASE_CUTOVER' },
);

function syncPath(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The endpoint the SAVED configuration resolves to, evaluated in a fresh
 * process exactly as the next `pm2 restart ecosystem.config.cjs` will. This
 * process's own require cache and environment captured the pre-cutover mode.
 */
function readSavedEndpoint() {
  const config = join(PATHS.installRoot, 'ecosystem.config.cjs');
  const code = `const c=require(${JSON.stringify(config)});process.stdout.write(JSON.stringify(c.DATABASE_ENDPOINTS?.[c.DATABASE_MODE]??null))`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: PATHS.installRoot, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => { if (stdout.length < 4096) stdout += chunk; });
    child.once('error', () => resolve(null));
    child.once('close', status => {
      try { resolve(status === 0 ? JSON.parse(stdout) : null); } catch { resolve(null); }
    });
  });
}

async function assertSavedTarget(target) {
  if (JSON.stringify(await readSavedEndpoint()) !== JSON.stringify(target)) {
    throw refused('the saved configuration does not resolve to the recorded target');
  }
}

/**
 * Forward-only, idempotent mode commit: rewrite `.env` PGMODE to the RECORDED
 * target. Recovery at `committing` repeats exactly this write — it never
 * guesses from the file's current contents or restores the source mode.
 * Every other line is preserved byte for byte.
 */
async function commitSavedMode(target) {
  const envPath = join(PATHS.installRoot, '.env');
  // .env lives beside data/, outside the data-root write guard: a test run
  // must never rewrite a real install's configuration.
  if (isTestRunner() && !isDisposableRoot(PATHS.installRoot)) {
    throw refused('a test run cannot commit a real install configuration');
  }
  let content = '';
  let mode = 0o600;
  try {
    content = readFileSync(envPath, 'utf8');
    mode = statSync(envPath).mode & 0o777;
  } catch (err) {
    if (err.code !== 'ENOENT') throw refused('the saved configuration is unreadable');
  }
  const line = `PGMODE=${target.mode}`;
  const next = /^PGMODE=.*$/m.test(content)
    ? content.replace(/^PGMODE=.*$/gm, line)
    : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  if (next !== content) {
    const pending = join(PATHS.installRoot, `.env.${randomUUID()}.pending`);
    const fd = openSync(pending, 'wx', mode);
    try {
      writeFileSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(pending, envPath);
    syncPath(PATHS.installRoot);
  }
  await assertSavedTarget(target);
}

/**
 * Restart the recorded server with the committed configuration and wait for
 * THAT restarted process — the one PM2 reports now — to publish proof that its
 * own pool reached the recorded target. PM2 `online`, the saved mode, or a
 * proof from an earlier pid is not success. The server is restarted at most
 * once per attempt; a crash-looping or wrong-pool server times out fenced.
 */
async function awaitRestartedTarget(journal, id, token, saved, { proofTimeoutMs = PROOF_TIMEOUT_MS, pollMs = POLL_MS }) {
  const deadline = Date.now() + proofTimeoutMs;
  let restarted = false;
  while (true) {
    journal.assertEnteredCoordinatorWorker(id, token);
    const server = (await readRecordedProducers(saved)).find(row => row.name === 'portos-server');
    if (server.status === 'online' && server.pid > 0 && journal.readTargetProof(id, server.pid)) return server.pid;
    if (server.status !== 'online' && !restarted) {
      journal.assertEnteredCoordinatorWorker(id, token);
      const result = await restartMaintenanceProducer('portos-server').catch(() => null);
      if (result?.success !== true) throw refused('the server could not be restarted');
      restarted = true;
    }
    if (Date.now() >= deadline) throw refused('the restarted server did not prove the target backend');
    await delay(pollMs);
  }
}

/**
 * Internal worker body for one entered coordinator. Transfer stages run the
 * offline transfer (quiescence, recorded dump, one target transaction); then:
 *
 *   importing → committing   only with this operation's committed import receipt
 *   committing → verifying   after `.env` durably names the target and a fresh
 *                            evaluation of the saved config resolves to it
 *   verifying → verified     after the restarted server proved its own pool
 *   verified → released      authority record, then the fence moves to the
 *                            completed archive; CoS restarts afterward
 *
 * Source authority holds until the mode commit; target authority afterward.
 * A recovered successor resumes at the recorded stage and never reverses.
 * `options` only shortens waits for subprocess tests.
 */
export async function runDatabaseCutover(id, token, options = {}) {
  const journal = createDatabaseMaintenanceJournal();
  let operation = journal.enterCoordinatorWorker(id, token);
  if (TRANSFER_STAGES.includes(operation.stage)) {
    await runDatabaseTransfer(id, token, { ...options, entered: true });
    operation = journal.assertEnteredCoordinatorWorker(id, token);
  }
  const saved = journal.readProducerSnapshot(id, token);
  if (!saved) throw refused('the producer identities were never recorded');
  if (operation.stage === 'importing') {
    if (!journal.readTransferImport(id)) throw refused('the target import has not committed');
    operation = journal.transition(id, token, 'importing', 'committing');
  }
  if (operation.stage === 'committing') {
    await commitSavedMode(operation.target);
    journal.assertEnteredCoordinatorWorker(id, token);
    operation = journal.transition(id, token, 'committing', 'verifying');
  }
  if (operation.stage === 'verifying') {
    await awaitRestartedTarget(journal, id, token, saved, options);
    operation = journal.transition(id, token, 'verifying', 'verified');
  }
  if (operation.stage !== 'verified') throw refused(`stage ${operation.stage} cannot be released`);
  // A hand edit while fenced must never release admission onto another backend.
  await assertSavedTarget(operation.target);
  journal.releaseAdmission(id, token);

  // Admission is open; CoS boots through its own fence and authority check.
  let cosRestarted = false;
  if (saved.find(row => row.name === 'portos-cos')?.status === 'online') {
    cosRestarted = (await restartMaintenanceProducer('portos-cos').catch(() => null))?.success === true;
    if (!cosRestarted) console.error('❌ Database cutover released, but portos-cos did not restart; start it with pm2');
  }
  return { id, stage: 'released', source: operation.source.mode, target: operation.target.mode,
    importCommitted: true, sourceRetained: true, restartVerified: true, cosRestarted };
}

/**
 * Same-operation recovery for the operator CLI and the authenticated API.
 * Requires the current owner's supervisor exit receipt (or an owner whose
 * worker was never reserved); repeated calls reuse the one persisted successor
 * and never start a second worker for it. Returns bounded status only.
 */
export async function recoverDatabaseCutover(id) {
  const journal = createDatabaseMaintenanceJournal();
  const token = journal.prepareRecovery(id);
  if (!token) return { id, stage: journal.read()?.stage ?? 'idle', recovery: 'running' };
  const { spawnDatabaseMaintenanceWorker } = await import('../lib/detachedSpawn.js');
  let worker;
  try {
    worker = await spawnDatabaseMaintenanceWorker(id, token);
  } catch {
    // A concurrent recovery already reserved this successor's one-use worker.
    if (journal.coordinatorStatus(id).state === 'awaiting-exit') return { id, stage: journal.read()?.stage ?? 'idle', recovery: 'running' };
    throw refused('the recovery worker could not be launched');
  }
  worker.on('error', () => console.error('❌ Database cutover recovery worker failed to launch'));
  return { id, stage: journal.read()?.stage ?? 'idle', recovery: 'launched' };
}
