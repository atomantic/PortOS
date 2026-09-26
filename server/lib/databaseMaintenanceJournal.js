import { existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';

const endpointSchema = z.object({
  mode: z.enum(['native', 'docker']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
}).strict();

const journalSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  stage: z.literal('accepted'),
  createdAt: z.string().datetime(),
  source: endpointSchema,
  target: endpointSchema,
}).strict();

const normalizedHost = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase())
  ? 'loopback' : host.toLowerCase();

const databaseMaintenanceError = () => Object.assign(
  new Error('Persistent database maintenance is active or requires recovery. Inspect scripts/database-maintenance.mjs status.'),
  { status: 503, code: 'DATABASE_MAINTENANCE' },
);

function syncDirectory(path) {
  // Windows does not expose directory fsync through Node. The fence still
  // exists before journal publication; unreadable/incomplete state fails shut.
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

/**
 * The DIRECTORY is the fence, not a successfully parsed journal. In particular,
 * a crash between mkdir and journal publication must never reopen admission.
 * Admission linearizes at the synchronous filesystem check, before the first
 * pool checkout/await. A call admitted just before publication may acquire its
 * connection or spawn afterward. This is NOT a quiescence/snapshot guarantee:
 * the coordinator must drain/stop every writer and in-flight spawn before dump.
 */
export function createDatabaseMaintenanceJournal(dataDir = PATHS.data) {
  const activeDir = join(dataDir, 'database-maintenance');
  const recordPath = join(activeDir, 'operation.json');

  const isFenced = () => {
    try {
      // Unlike existsSync, lstat distinguishes missing from unreadable and
      // treats a dangling symlink as a fence, not a missing operation.
      lstatSync(activeDir);
      return true;
    } catch (err) {
      return err.code !== 'ENOENT';
    }
  };

  const assertAdmission = () => {
    if (isFenced()) throw databaseMaintenanceError();
  };

  const read = () => {
    if (!isFenced()) return null;
    try {
      if (!lstatSync(activeDir).isDirectory() || !lstatSync(recordPath).isFile()) {
        throw databaseMaintenanceError();
      }
      return journalSchema.parse(JSON.parse(readFileSync(recordPath, 'utf8')));
    } catch {
      throw databaseMaintenanceError();
    }
  };

  const begin = ({ source, target }) => {
    assertNotRealDataWrite(activeDir, 'database maintenance begin');
    const record = journalSchema.parse({
      version: 1, id: randomUUID(), stage: 'accepted',
      createdAt: new Date().toISOString(), source, target,
    });
    if (source.mode === target.mode ||
        (normalizedHost(source.host) === normalizedHost(target.host) && source.port === target.port)) {
      throw new Error('Database maintenance requires distinct source and target backends.');
    }
    mkdirSync(dataDir, { recursive: true });
    // Exclusive mkdir is also the cross-process begin lock. No rollback on a
    // failed publication: leaving the fence closed is the recoverable outcome.
    mkdirSync(activeDir, { mode: 0o700 });
    syncDirectory(dataDir);
    const temporary = join(activeDir, 'operation.pending');
    writeDurableExclusive(temporary, record);
    renameSync(temporary, recordPath);
    syncDirectory(activeDir);
    return record;
  };

  const cancel = (id, source) => {
    assertNotRealDataWrite(activeDir, 'database maintenance cancel');
    // A per-operation exclusive cancellation claim prevents two cancellations
    // from renaming a later operation after the first has released this one.
    // An interrupted cancellation leaves this marker and fails closed; it must
    // never be automatically stolen on a timeout or an unverified PID guess.
    const initial = read();
    if (!initial || initial.id !== id) throw new Error('Database maintenance operation does not match.');
    const parsedSource = endpointSchema.parse(source);
    if (JSON.stringify(initial.source) !== JSON.stringify(parsedSource)) {
      throw new Error('Saved database endpoint changed; source-only cancellation refused.');
    }
    writeDurableExclusive(join(activeDir, 'cancel-' + id + '.claim'), { id });
    const current = read();
    if (current.id !== id || current.stage !== 'accepted') throw databaseMaintenanceError();
    const archiveDir = join(dataDir, 'database-maintenance-cancelled');
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    // Archive before reopening admission; retain the operation's direction as
    // local recovery evidence. Never remove/overwrite an existing archive.
    const destination = join(archiveDir, id);
    if (existsSync(destination)) throw databaseMaintenanceError();
    renameSync(activeDir, destination);
    syncDirectory(archiveDir);
    syncDirectory(dataDir);
    return { id, stage: 'cancelled' };
  };

  return { isFenced, assertAdmission, read, begin, cancel };
}

const journal = createDatabaseMaintenanceJournal();
export const assertDatabaseAdmission = journal.assertAdmission;
