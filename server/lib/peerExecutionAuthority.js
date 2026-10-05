/** Non-rewound machine authority. No grants, adapter, or HTTP route is installed. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { assertNotRealDataWrite } from './testDataIsolation.js';

const uuid = z.string().uuid();
const adoptionIntentSchema = z.object({ version: z.literal(1), kind: z.literal('empty-adoption'), id: uuid }).strict();
const recordSchema = z.object({
  version: z.literal(1), epoch: uuid, revision: z.number().int().positive().safe(),
  phase: z.enum(['ready', 'capturing', 'reconciling']),
  settledRecoveryId: uuid.nullable(),
  emptyAdoptionId: uuid.nullable(),
  recovery: z.object({ id: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    count: z.number().int().nonnegative().safe().nullable() }).strict().nullable(),
}).strict().refine(value => (value.phase === 'ready') === (value.recovery === null))
  .refine(value => value.phase !== 'reconciling' || (value.recovery.digest && value.recovery.count !== null));
export const executionAuthorityError = message => Object.assign(new Error(message), {
  code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE', status: 503,
});

export function createPeerExecutionAuthority(dataDir, { io = fs, assertWrite = assertNotRealDataWrite, makeId = randomUUID } = {}) {
  const path = join(dataDir, 'peer-execution-authority.json');
  const recoveryPath = join(dataDir, 'peer-execution-recovery.jsonl');
  const lock = join(dataDir, '.peer-execution-authority-lock');
  let damaged = false;
  const exists = file => {
    try { io.lstatSync(file); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  };
  const syncDirectory = () => {
    if (process.platform === 'win32') return;
    const fd = io.openSync(dataDir, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  };
  const read = ({ inside = false, recovery = false } = {}) => {
    if ((!recovery && damaged) || (!inside && exists(lock))) throw executionAuthorityError('Execution authority needs reconciliation.');
    if (!exists(path)) return null;
    try {
      if (!io.lstatSync(path).isFile()) throw new Error('not a regular file');
      return recordSchema.parse(JSON.parse(io.readFileSync(path, 'utf8')));
    } catch { throw executionAuthorityError('Execution authority is unreadable; it cannot be reset.'); }
  };
  const transaction = (change, { emptyAdoptionId = null } = {}) => {
    assertWrite(path, 'peer execution authority');
    if (damaged) throw executionAuthorityError('Execution authority publication was interrupted.');
    io.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // The first legacy adoption has no earlier record. An atomic intent record
    // makes even a crash before its first JSON publication recoverable by ID.
    try {
      if (emptyAdoptionId) {
        const intent = join(dataDir, `.peer-execution-adoption-${makeId()}.pending`);
        const fd = io.openSync(intent, 'wx', 0o600);
        try {
          io.writeFileSync(fd, JSON.stringify({ version: 1, kind: 'empty-adoption', id: emptyAdoptionId }) + '\n');
          io.fsyncSync(fd);
        } finally { io.closeSync(fd); }
        // Same no-replace hard-link primitive as databaseRestoreRecovery.begin;
        // native Windows does not need symlink privilege for this regular file.
        try { io.linkSync(intent, lock); } finally { io.unlinkSync(intent); }
        syncDirectory();
      } else io.mkdirSync(lock, { mode: 0o700 });
    }
    catch { throw executionAuthorityError('Execution authority is being changed or needs recovery.'); }
    let publishing = false;
    try {
      const next = change(read({ inside: true }));
      recordSchema.parse(next);
      publishing = true;
      const pending = join(dataDir, `.peer-execution-authority-${makeId()}.pending`);
      const fd = io.openSync(pending, 'wx', 0o600);
      try { io.writeFileSync(fd, JSON.stringify(next) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      io.renameSync(pending, path);
      syncDirectory();
      publishing = false;
      return structuredClone(next);
    } catch (err) {
      if (publishing) damaged = true;
      throw err;
    } finally {
      // Never steal an interrupted publication by age or PID.
      if (!damaged) {
        try {
          if (emptyAdoptionId) io.unlinkSync(lock); else io.rmdirSync(lock);
          syncDirectory();
        } catch { damaged = true; }
      }
    }
  };
  const requireReady = epoch => {
    const current = read();
    if (!current || current.phase !== 'ready' || current.epoch !== epoch)
      throw executionAuthorityError('Execution evidence is stale or a restore is awaiting reconciliation.');
    return current;
  };
  const initialize = () => transaction(current => current ?? {
    version: 1, epoch: makeId(), revision: 1, phase: 'ready', recovery: null, settledRecoveryId: null, emptyAdoptionId: null,
  });
  const beginRestore = id => {
    uuid.parse(id);
    return transaction(current => {
      if (!current) throw executionAuthorityError('Initialize the empty ledger before restoring execution records.');
      if (current.recovery?.id === id) return current;
      if (current.phase !== 'ready') throw executionAuthorityError('Another execution recovery is pending.');
      return { ...current, emptyAdoptionId: null, epoch: makeId(), revision: current.revision + 1, phase: 'capturing',
        recovery: { id, digest: null, count: null } };
    });
  };
  // Internal restore primitive: caller MUST hold the ledger writer transaction
  // lock and have positively proved BOTH tables empty. No age/PID lock stealing.
  const recoverEmptyAdoption = id => {
    uuid.parse(id);
    const current = read({ inside: true, recovery: true });
    const locked = exists(lock);
    const lockStat = locked && io.lstatSync(lock);
    let intent = false;
    if (lockStat?.isFile() && lockStat.size <= 256) {
      try { intent = adoptionIntentSchema.parse(JSON.parse(io.readFileSync(lock, 'utf8'))).id === id; }
      catch { throw executionAuthorityError('The empty-adoption intent is unreadable.'); }
    }
    if (current?.emptyAdoptionId !== id && !(intent && !current)) {
      if (locked || damaged) throw executionAuthorityError('Interrupted authority has no matching empty-adoption proof.');
      return current;
    }
    assertWrite(path, 'peer execution empty restore recovery');
    if (locked) {
      if (lockStat.isFile()) {
        if (!intent) throw executionAuthorityError('The empty-adoption owner changed.');
        io.unlinkSync(lock);
      } else if (lockStat.isDirectory()) io.rmdirSync(lock); // Refuses unexpected contents.
      else throw executionAuthorityError('Unexpected empty-adoption lock type.');
      syncDirectory();
    }
    damaged = false;
    return current;
  };
  const beginEmptyAdoption = id => {
    uuid.parse(id);
    return transaction(current => {
      if (current?.emptyAdoptionId === id) return current;
      if (current) throw executionAuthorityError('Existing authority cannot be replaced by legacy empty adoption.');
      return { version: 1, epoch: makeId(), revision: 1, phase: 'capturing',
        recovery: { id, digest: null, count: null }, settledRecoveryId: null, emptyAdoptionId: id };
    }, { emptyAdoptionId: id });
  };
  const recordSnapshot = (id, digest, count) => transaction(current => {
    if (current?.recovery?.id !== id || current.phase !== 'capturing')
      throw executionAuthorityError('The execution recovery owner changed.');
    return { ...current, revision: current.revision + 1, phase: 'reconciling', recovery: { id, digest, count } };
  });
  const completeRestore = id => transaction(current => {
    if (current?.recovery?.id !== id || current.phase !== 'reconciling')
      throw executionAuthorityError('The execution recovery owner changed.');
    return { ...current, revision: current.revision + 1, phase: 'ready', recovery: null, settledRecoveryId: id };
  });
  return { read, requireReady, initialize, beginRestore, beginEmptyAdoption, recoverEmptyAdoption,
    recordSnapshot, completeRestore, recoveryPath, assertWrite };
}
