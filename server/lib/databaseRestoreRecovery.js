/**
 * Durable, machine-local journal for ONE in-flight snapshot database restore
 * (#9725). Its presence is the admission fence: while the file exists, only
 * the matching recovery operation may use the database, in this process and
 * across restart. The record carries what recovery needs and nothing else —
 * the operation id, the admitted dump digest, the ORIGINAL pre-replay sync
 * feed positions and the pending stage. No credentials, no copied records.
 *
 * Stages:
 *   replaying — published BEFORE the destructive replay. Whether the replay
 *               committed is unknown until its transactional receipt (a row in
 *               `restore_receipts` keyed by this id, written inside the replay
 *               transaction) is inspected.
 *   repairing — replay committed; schema/migration/sequence/cursor repair is
 *               pending. Never replays again.
 * Completion (or a proven rollback) removes the file, reopening admission.
 */
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';

export const DATABASE_RESTORE_RECOVERY_FILE = 'database-restore-recovery.json';
export const DATABASE_RESTORE_RECOVERY_STAGES = Object.freeze(['replaying', 'repairing']);

const recordSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  stage: z.enum(DATABASE_RESTORE_RECOVERY_STAGES),
  createdAt: z.string().datetime(),
  snapshotId: z.string().min(1).max(255),
  dumpSha256: z.string().regex(/^[0-9a-f]{64}$/),
  // pg_sequences rows captured before replay; last_value stays a decimal
  // string because feed positions exceed Number.MAX_SAFE_INTEGER.
  feedPositions: z.array(z.object({
    sequencename: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    last_value: z.string().regex(/^-?\d{1,20}$/),
  }).strict()).max(256),
}).strict();

export const databaseRestoreRecoveryError = () => Object.assign(
  new Error('A committed database restore is awaiting recovery. Finish it from Settings > Backup (or restart PortOS to retry automatically) before using the database.'),
  { status: 503, code: 'DATABASE_RESTORE_RECOVERY' },
);

function syncDirectory(path) {
  // Windows does not expose directory fsync through Node.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurableExclusive(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createDatabaseRestoreRecovery(dataDir = PATHS.data) {
  const recordPath = join(dataDir, DATABASE_RESTORE_RECOVERY_FILE);
  const pendingPath = () => join(dataDir, `.database-restore-recovery-${randomUUID()}.pending`);

  // The FILE is the fence, not a successfully parsed record: anything at the
  // path other than a confirmed ENOENT (unreadable, wrong type, damaged)
  // keeps ordinary database work closed.
  const isFenced = () => {
    try {
      lstatSync(recordPath);
      return true;
    } catch (err) {
      return err.code !== 'ENOENT';
    }
  };

  const assertAdmission = () => {
    if (isFenced()) throw databaseRestoreRecoveryError();
  };

  // null when no restore is pending; throws (fails closed) when the record
  // exists but cannot be read or validated.
  const read = () => {
    if (!isFenced()) return null;
    try {
      if (!lstatSync(recordPath).isFile()) throw databaseRestoreRecoveryError();
      return recordSchema.parse(JSON.parse(readFileSync(recordPath, 'utf8')));
    } catch {
      if (!isFenced()) return null;
      throw databaseRestoreRecoveryError();
    }
  };

  // Published before the destructive replay. link() is an atomic no-replace
  // publication of already-fsynced bytes, so a second restore can never
  // overwrite a pending operation's original feed positions.
  const begin = ({ snapshotId, dumpSha256, feedPositions }) => {
    assertNotRealDataWrite(recordPath, 'database restore recovery begin');
    const record = recordSchema.parse({
      version: 1, id: randomUUID(), stage: 'replaying', createdAt: new Date().toISOString(),
      snapshotId, dumpSha256, feedPositions,
    });
    const pending = pendingPath();
    writeDurableExclusive(pending, record);
    try {
      linkSync(pending, recordPath);
    } catch (err) {
      if (err.code === 'EEXIST') throw databaseRestoreRecoveryError();
      throw err;
    } finally {
      unlinkSync(pending);
    }
    syncDirectory(dataDir);
    return record;
  };

  // Forward-only: replaying -> repairing, for the SAME operation. Identity,
  // digest and the original floors are carried over unchanged.
  const markCommitted = (id) => {
    assertNotRealDataWrite(recordPath, 'database restore recovery commit');
    const current = read();
    if (!current || current.id !== id) throw databaseRestoreRecoveryError();
    if (current.stage === 'repairing') return current;
    const next = recordSchema.parse({ ...current, stage: 'repairing' });
    const pending = pendingPath();
    writeDurableExclusive(pending, next);
    renameSync(pending, recordPath);
    syncDirectory(dataDir);
    return next;
  };

  // Reopen admission: repair completed, or the replay provably rolled back.
  const release = (id) => {
    assertNotRealDataWrite(recordPath, 'database restore recovery release');
    const current = read();
    if (!current || current.id !== id) throw databaseRestoreRecoveryError();
    unlinkSync(recordPath);
    syncDirectory(dataDir);
  };

  return { path: recordPath, isFenced, assertAdmission, read, begin, markCommitted, release };
}
