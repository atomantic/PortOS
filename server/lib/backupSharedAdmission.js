/** Cross-process publication admission on the install's shared local filesystem. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';

const busy = (message, details = {}) => Object.assign(new Error(message), {
  status: 503, code: 'BACKUP_SNAPSHOT_BUSY', ...details,
});

/**
 * Atomic directory creation is available on Windows as well as POSIX. Readers
 * register BEFORE checking the cut gate; the cutter creates its gate BEFORE
 * checking readers. A reader racing the cutter therefore either gets drained
 * or observes the gate and never starts its mutation. No PID/age reclamation:
 * a crashed writer may have left half a publication behind.
 */
export function createBackupSharedAdmission(directory, { io = fs, makeId = randomUUID, assertWrite = assertNotRealDataWrite } = {}) {
  const readers = join(directory, 'publications');
  const cutPath = join(directory, 'cut');
  const generation = makeId();
  const exists = path => {
    try { io.lstatSync(path); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const syncDir = path => {
    if (process.platform === 'win32') return;
    const fd = io.openSync(path, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  };
  const prepare = () => {
    assertWrite(directory, 'backup publication admission');
    const firstCreated = io.mkdirSync(readers, { recursive: true, mode: 0o700 });
    // Persist the entire newly created ancestry, including the parent entry
    // naming its first directory, before any asset mutation can start. Also
    // sync the normal control/data parents when another process won mkdir.
    const highest = firstCreated ? dirname(firstCreated) : dirname(directory);
    for (let path = readers; ; path = dirname(path)) {
      syncDir(path);
      if (path === highest || dirname(path) === path) break;
    }
  };
  const describe = path => {
    try {
      const owner = JSON.parse(io.readFileSync(join(path, 'owner.json'), 'utf8'));
      if (owner.version !== 1 || typeof owner.id !== 'string' || typeof owner.generation !== 'string'
        || !Number.isInteger(owner.pid) || !['publication', 'snapshot'].includes(owner.kind)) throw new Error('Invalid ownership record');
      return { ...owner, path, ...(exists(join(path, 'uncertain')) ? { uncertain: true } : {}) };
    } catch { return { path, unreadable: true }; }
  };
  const writeOwner = (path, kind) => {
    const owner = { version: 1, id: makeId(), generation, pid: process.pid, kind, startedAt: new Date().toISOString() };
    const fd = io.openSync(join(path, 'owner.json'), 'wx', 0o600);
    try { io.writeFileSync(fd, JSON.stringify(owner) + '\n'); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    syncDir(path);
    syncDir(kind === 'publication' ? readers : directory);
    let active = true;
    return {
      owner, path,
      get active() { return active; },
      markUncertain() {
        const marker = join(path, 'uncertain');
        const fd = io.openSync(marker, 'wx', 0o600);
        try { io.writeFileSync(fd, 'Publication rollback failed; reconcile both stores before retiring this owner.\n'); io.fsyncSync(fd); }
        finally { io.closeSync(fd); }
        syncDir(path);
      },
      release() {
        if (!active) return;
        if (describe(path).id !== owner.id) throw busy(`Backup admission ownership changed at ${path}; reconcile the recorded owner before retrying.`, { recoveryPath: path });
        // Only our nonce-checked directory. Failure leaves an explicit blocker.
        io.unlinkSync(join(path, 'owner.json'));
        io.rmdirSync(path);
        syncDir(kind === 'publication' ? readers : directory);
        active = false;
      },
    };
  };
  const tryPublication = ({ parent } = {}) => {
    // Avoid durable registration churn while a long snapshot owns the gate.
    // The second check AFTER registration below still closes the race.
    const joinsParent = parent?.active && exists(parent.path);
    if (!joinsParent && exists(cutPath)) return null;
    prepare();
    const path = join(readers, makeId());
    io.mkdirSync(path, { mode: 0o700 });
    const lease = writeOwner(path, 'publication');
    // A synchronous fan-out may join its live parent while a cut drains it.
    // Registration completes before the parent can relinquish its own lease.
    if (!joinsParent && exists(cutPath)) {
      lease.release();
      return null;
    }
    return lease;
  };
  const reserveCut = () => {
    prepare();
    try { io.mkdirSync(cutPath, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw busy(`Backup snapshot cut already owned at ${cutPath}. If its process stopped, reconcile the interrupted backup or restore before removing its ownership record.`, { recoveryPath: cutPath, owner: describe(cutPath) });
    }
    return writeOwner(cutPath, 'snapshot');
  };
  const publications = () => {
    try { return io.readdirSync(readers).map(name => describe(join(readers, name))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { tryPublication, reserveCut, publications, cutPending: () => exists(cutPath),
    status: () => ({ cut: exists(cutPath) ? describe(cutPath) : null, publications: publications() }) };
}

let shared;
export const backupSharedAdmission = new Proxy({}, {
  get(_target, key) {
    shared ??= createBackupSharedAdmission(join(PATHS.data, 'backup-admission'));
    return shared[key];
  },
});
