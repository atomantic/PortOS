#!/usr/bin/env node
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintenanceBeginSchema, maintenanceJournalSchema, syncMaintenanceDirectory } from '../server/lib/maintenanceAdmission.js';
import { PATHS } from '../server/lib/paths.js';
import { assertNotRealDataWrite } from '../server/lib/testDataIsolation.js';

const listProcesses = () => import('../server/services/pm2.js').then(pm2 => pm2.listMaintenanceProcesses());
const refuse = message => { throw new Error(message); };

/** Offline operator disposition of a transaction, never settlement of its work. */
export async function recoverMaintenanceTransaction(reason, { data = PATHS.data, io = fs, processes = listProcesses } = {}) {
  const { reason: confirmedReason } = maintenanceBeginSchema.parse({ reason });
  const offline = async () => {
    const inventory = await processes();
    if (!Array.isArray(inventory) || inventory.some(proc => !proc || typeof proc.name !== 'string' || typeof proc.status !== 'string'))
      refuse('PM2 process state is unreadable; recovery refused.');
    if (inventory.some(proc => ['portos-server', 'portos-cos'].includes(proc.name)
      && (!['stopped', 'errored'].includes(proc.status) || proc.pid !== 0)))
      refuse('Stop portos-server and portos-cos in PM2 before recovery.');
  };
  await offline();
  const directory = join(data, 'workflow-maintenance');
  const file = join(directory, 'state.json');
  const lock = join(directory, 'transaction');
  const stat = path => {
    try { return io.lstatSync(path); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };
  const dirStat = stat(directory);
  if (dirStat && !dirStat.isDirectory()) refuse('The maintenance journal must be a real directory.');
  const originalStat = stat(file);
  if (originalStat && !originalStat.isFile()) refuse('state.json must be a regular file, not a link or directory.');
  const original = originalStat ? io.readFileSync(file) : null;
  // Use exactly the runtime schema; future or damaged journals require compatible
  // code/data recovery, never replacement with an empty journal.
  const state = original ? maintenanceJournalSchema.parse(JSON.parse(original.toString('utf8')))
    : { version: 1, revision: 0, hold: null, operations: [] };
  const lockStat = stat(lock);
  if (lockStat && !lockStat.isDirectory()) refuse('The transaction lock must be a real directory.');
  const pending = dirStat ? io.readdirSync(directory).filter(name => /^pending-.*\.json$/.test(name)).sort().map(name => {
    const stats = stat(join(directory, name));
    if (!stats?.isFile()) refuse('Pending journal evidence must be regular files.');
    return { name, size: stats.size };
  }) : [];
  await offline();
  const identity = stats => stats && [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
  const current = stat(file);
  if (identity(current) !== identity(originalStat) || identity(stat(lock)) !== identity(lockStat)
    || (original && !io.readFileSync(file).equals(original)))
    refuse('The maintenance journal changed during inspection; inspect again before recovery.');
  assertNotRealDataWrite(directory, 'maintenance transaction recovery');
  io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lockStat) io.mkdirSync(lock, { mode: 0o700 });
  const at = new Date().toISOString();
  const archiveDir = join(directory, `recovered-${at.replace(/:/g, '-')}-${randomUUID()}`);
  io.mkdirSync(archiveDir, { mode: 0o700 });
  const durableWrite = (path, contents) => {
    const fd = io.openSync(path, 'wx', 0o600);
    try { io.writeFileSync(fd, contents); io.fsyncSync(fd); } finally { io.closeSync(fd); }
  };
  if (original) durableWrite(join(archiveDir, 'state.json'), original);
  if (!state.hold) {
    state.revision++;
    state.hold = { id: randomUUID(), revision: state.revision, owner: 'Transaction recovery',
      reason: confirmedReason, requestedAt: at };
  }
  maintenanceJournalSchema.parse(state);
  const receipt = { version: 1, reason: confirmedReason, at, lockMtime: lockStat?.mtime.toISOString() ?? null,
    pending, originalStateSha256: original ? createHash('sha256').update(original).digest('hex') : null,
    hold: state.hold };
  durableWrite(join(archiveDir, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
  // Interrupted writes may never have flushed their data. A directory fsync
  // preserves names, not those bytes; retain the original fence on flush failure.
  for (const { name } of pending) {
    // Windows FlushFileBuffers requires write access; r+ never truncates evidence.
    const fd = io.openSync(join(directory, name), 'r+');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    io.renameSync(join(directory, name), join(archiveDir, name));
  }
  syncMaintenanceDirectory(archiveDir, io);
  // Publish and fsync a hold BEFORE moving the admission lock. A crash at any
  // step retains either the original fence or the deliberate recovery hold.
  const staged = join(directory, `pending-${randomUUID()}.json`);
  durableWrite(staged, `${JSON.stringify(state)}\n`);
  io.renameSync(staged, file);
  syncMaintenanceDirectory(directory, io);
  io.renameSync(lock, join(archiveDir, 'transaction'));
  syncMaintenanceDirectory(archiveDir, io);
  syncMaintenanceDirectory(directory, io);
  return { archiveDir, hold: state.hold, pendingCount: pending.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [confirmation, ...reason] = process.argv.slice(2);
    if (confirmation !== '--confirm') throw new Error('Usage: node scripts/recover-maintenance-transaction.mjs --confirm <reason>');
    console.log(JSON.stringify(await recoverMaintenanceTransaction(reason.join(' '))));
  } catch (err) { console.error(`❌ Maintenance recovery refused: ${err.message}`); process.exitCode = 1; }
}
