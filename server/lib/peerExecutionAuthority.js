/** Non-rewound machine authority. No grants, adapter, or HTTP route is installed. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { assertNotRealDataWrite } from './testDataIsolation.js';

const uuid = z.string().uuid();
const recordSchema = z.object({
  version: z.literal(1), epoch: uuid, revision: z.number().int().positive().safe(),
  phase: z.enum(['ready', 'capturing', 'reconciling']),
  settledRecoveryId: uuid.nullable(),
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
  const read = ({ inside = false } = {}) => {
    if (damaged || (!inside && exists(lock))) throw executionAuthorityError('Execution authority needs reconciliation.');
    if (!exists(path)) return null;
    try {
      if (!io.lstatSync(path).isFile()) throw new Error('not a regular file');
      return recordSchema.parse(JSON.parse(io.readFileSync(path, 'utf8')));
    } catch { throw executionAuthorityError('Execution authority is unreadable; it cannot be reset.'); }
  };
  const transaction = change => {
    assertWrite(path, 'peer execution authority');
    if (damaged) throw executionAuthorityError('Execution authority publication was interrupted.');
    io.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { io.mkdirSync(lock, { mode: 0o700 }); }
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
        try { io.rmdirSync(lock); syncDirectory(); } catch { damaged = true; }
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
    version: 1, epoch: makeId(), revision: 1, phase: 'ready', recovery: null, settledRecoveryId: null,
  });
  const beginRestore = id => {
    uuid.parse(id);
    return transaction(current => {
      if (!current) throw executionAuthorityError('Initialize the empty ledger before restoring execution records.');
      if (current.recovery?.id === id) return current;
      if (current.phase !== 'ready') throw executionAuthorityError('Another execution recovery is pending.');
      return { ...current, epoch: makeId(), revision: current.revision + 1, phase: 'capturing',
        recovery: { id, digest: null, count: null } };
    });
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
  return { read, requireReady, initialize, beginRestore, recordSnapshot, completeRestore, recoveryPath, assertWrite };
}
