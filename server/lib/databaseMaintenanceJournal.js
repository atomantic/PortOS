import { existsSync, lstatSync, mkdirSync, linkSync, unlinkSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';

export const databaseMaintenanceEndpointSchema = z.object({
  mode: z.enum(['native', 'docker']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
}).strict();

const stages = ['accepted', 'quiescing', 'exporting', 'importing', 'committing', 'verifying', 'verified'];

const journalSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  stage: z.enum(stages),
  createdAt: z.string().datetime(),
  source: databaseMaintenanceEndpointSchema,
  target: databaseMaintenanceEndpointSchema,
}).strict();

const coordinatorSchema = z.object({
  id: z.string().uuid(),
  token: z.string().uuid(),
}).strict();
const successorSchema = coordinatorSchema.extend({ previousToken: z.string().uuid() });
const decisionSchema = coordinatorSchema.extend({
  stage: z.enum(stages),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('transition'), nextStage: z.enum(stages) }).strict(),
    z.object({ kind: z.literal('recovery'), recoveryToken: z.string().uuid() }).strict(),
  ]),
});

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
      let current = journalSchema.parse(JSON.parse(readFileSync(recordPath, 'utf8')));
      // Immutable publications cannot be overwritten by a delayed older writer.
      // Legacy journals keep their recorded stage as the history's starting point.
      for (const stage of stages.slice(stages.indexOf(current.stage) + 1)) {
        const stagePath = join(activeDir, 'published-' + stage + '.json');
        try { lstatSync(stagePath); } catch (err) {
          if (err.code === 'ENOENT') break;
          throw err;
        }
        if (!lstatSync(stagePath).isFile()) throw databaseMaintenanceError();
        const next = journalSchema.parse(JSON.parse(readFileSync(stagePath, 'utf8')));
        if (JSON.stringify(next) !== JSON.stringify({ ...current, stage })) throw databaseMaintenanceError();
        current = next;
      }
      return current;
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

  // Initial durable owner. Successors require explicit same-operation recovery
  // backed by the detached supervisor's exit receipt, never PID/elapsed time.
  const acquireCoordinator = (id) => {
    assertNotRealDataWrite(activeDir, 'database maintenance ownership');
    const current = read();
    if (!current || current.id !== id || current.stage !== 'accepted') throw databaseMaintenanceError();
    const token = randomUUID();
    writeDurableExclusive(join(activeDir, 'cancel-' + id + '.claim'), { id, token });
    syncDirectory(activeDir);
    const owned = read();
    if (!owned || owned.id !== id || owned.stage !== 'accepted') throw databaseMaintenanceError();
    return token;
  };

  // Recovery appends an immutable successor instead of overwriting ownership.
  // Each predecessor admits exactly one successor, even across processes. A
  // missing/partial worker receipt never authorizes reclaiming an owner.
  const readCoordinator = (id, rejectedPredecessor = null) => {
    const current = read();
    if (!current || current.id !== id) throw databaseMaintenanceError();
    const ownerPath = join(activeDir, 'cancel-' + id + '.claim');
    try { lstatSync(ownerPath); } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw databaseMaintenanceError();
    }
    if (!lstatSync(ownerPath).isFile()) throw databaseMaintenanceError();
    let owner = coordinatorSchema.parse(JSON.parse(readFileSync(ownerPath, 'utf8')));
    if (owner.id !== id) throw databaseMaintenanceError();
    const visited = new Set();
    while (true) {
      if (visited.has(owner.token)) throw databaseMaintenanceError();
      visited.add(owner.token);
      const nextPath = join(activeDir, 'coordinator-after-' + owner.token + '.json');
      try { lstatSync(nextPath); } catch (err) {
        if (err.code === 'ENOENT') return owner;
        throw databaseMaintenanceError();
      }
      if (!lstatSync(nextPath).isFile()) throw databaseMaintenanceError();
      const next = successorSchema.parse(JSON.parse(readFileSync(nextPath, 'utf8')));
      if (next.id !== id || next.previousToken !== owner.token || owner.token === rejectedPredecessor) throw databaseMaintenanceError();
      owner = { id, token: next.token };
    }
  };

  const assertCoordinator = (id, token) => {
    const owner = readCoordinator(id);
    if (!owner || typeof token !== 'string' || owner.token !== token) throw databaseMaintenanceError();
    return owner;
  };

  const workerDirectory = token => join(activeDir, 'worker-' + token);

  // Reserve once, BEFORE spawnDetached. Never reuse this directory: resetting
  // its exit sentinel could let an old supervisor acknowledge a later worker.
  // The caller must use cleanup:false and launch only the coordinator here.
  const reserveCoordinatorWorker = (id, token) => {
    assertNotRealDataWrite(activeDir, 'database maintenance worker reservation');
    const owner = assertCoordinator(id, token);
    const directory = workerDirectory(token);
    try { lstatSync(directory); throw databaseMaintenanceError(); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const pending = join(activeDir, 'worker-pending-' + randomUUID());
    mkdirSync(pending, { mode: 0o700 });
    try {
      writeDurableExclusive(join(pending, 'owner.json'), owner);
      syncDirectory(pending);
      // The complete, nonempty reservation is published at once. Another
      // launch cannot replace it (rename refuses a nonempty destination).
      renameSync(pending, directory);
      syncDirectory(activeDir);
    } finally {
      rmSync(pending, { recursive: true, force: true });
    }
    return directory;
  };

  const coordinatorStatus = (id) => {
    const owner = readCoordinator(id);
    if (!owner) return { state: 'unclaimed' };
    const directory = workerDirectory(owner.token);
    try { lstatSync(directory); } catch (err) {
      if (err.code === 'ENOENT') return { state: 'unregistered' };
      throw databaseMaintenanceError();
    }
    if (!lstatSync(directory).isDirectory()) throw databaseMaintenanceError();
    const bindingPath = join(directory, 'owner.json');
    if (!lstatSync(bindingPath).isFile()) throw databaseMaintenanceError();
    const binding = coordinatorSchema.parse(JSON.parse(readFileSync(bindingPath, 'utf8')));
    if (binding.id !== id || binding.token !== owner.token) throw databaseMaintenanceError();
    const exitPath = join(directory, 'exit');
    try { lstatSync(exitPath); } catch (err) {
      if (err.code === 'ENOENT') return { state: 'awaiting-exit' };
      throw databaseMaintenanceError();
    }
    if (!lstatSync(exitPath).isFile()) throw databaseMaintenanceError();
    const raw = readFileSync(exitPath, 'utf8');
    if (!/^-?\d{1,10}\r?\n?$/.test(raw)) throw databaseMaintenanceError();
    const exitCode = Number(raw.trim());
    if (!Number.isSafeInteger(exitCode) || exitCode < -2147483648 || exitCode > 4294967295) throw databaseMaintenanceError();
    return { state: 'exited', exitCode };
  };

  // The fixed maintenance worker checks both ownership and the supervisor's
  // one-use reservation. This grants no ordinary database/spawn admission.
  const assertCoordinatorWorker = (id, token) => {
    assertCoordinator(id, token);
    if (coordinatorStatus(id).state !== 'awaiting-exit') throw databaseMaintenanceError();
    return read();
  };

  const enterCoordinatorWorker = (id, token) => {
    assertNotRealDataWrite(activeDir, 'database maintenance worker entry');
    const current = assertCoordinatorWorker(id, token);
    // A second invocation with copied arguments cannot become a second worker.
    writeDurableExclusive(join(workerDirectory(token), 'started.json'), { id, token });
    syncDirectory(workerDirectory(token));
    assertCoordinatorWorker(id, token);
    return current;
  };

  // A durable CAS for EACH outgoing (owner, stage) state. Transition and
  // recovery compete on the SAME file, so a predecessor paused after checking
  // its token cannot publish a new stage after losing ownership. Interrupted
  // stage decisions can be completed identically before attempting recovery.
  const decide = (id, token, stage, action) => {
    const value = decisionSchema.parse({ id, token, stage, action });
    const destination = join(activeDir, 'decision-' + stage + '-' + token + '.json');
    const pending = join(activeDir, 'decision-' + randomUUID() + '.pending');
    writeDurableExclusive(pending, value);
    try {
      linkSync(pending, destination);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    } finally {
      unlinkSync(pending);
    }
    syncDirectory(activeDir);
    if (!lstatSync(destination).isFile()) throw databaseMaintenanceError();
    const winner = decisionSchema.parse(JSON.parse(readFileSync(destination, 'utf8')));
    if (winner.id !== id || winner.token !== token || winner.stage !== stage) throw databaseMaintenanceError();
    return winner.action;
  };

  // This transfers journal ownership only, NEVER database authority. Before
  // export/import a successor must re-establish writer/child quiescence: the
  // worker's exit says nothing about descendants it might have left behind.
  // No PID probe, clock, reverse operation, or source-success inference occurs.
  const recoverCoordinator = (id, previousToken, recoveryToken) => {
    assertNotRealDataWrite(activeDir, 'database maintenance coordinator recovery');
    coordinatorSchema.parse({ id, token: recoveryToken });
    coordinatorSchema.parse({ id, token: previousToken });
    if (recoveryToken === previousToken) throw databaseMaintenanceError();
    const owner = readCoordinator(id, recoveryToken);
    // The caller persists its recovery token before attempting publication.
    // A crash after link/fsync but before returning must be retryable by that
    // same claimant; another claimant must never learn or reuse its token.
    if (owner?.token === recoveryToken) {
      const published = successorSchema.parse(JSON.parse(readFileSync(
        join(activeDir, 'coordinator-after-' + previousToken + '.json'), 'utf8')));
      if (published.id !== id || published.previousToken !== previousToken || published.token !== recoveryToken) throw databaseMaintenanceError();
      syncDirectory(activeDir);
      return recoveryToken;
    }
    assertCoordinator(id, previousToken);
    if (coordinatorStatus(id).state !== 'exited') throw databaseMaintenanceError();
    // Only four transfer stages can advance here; each interrupted transition
    // completion moves strictly forward, never reverses an import to success.
    while (true) {
      const current = read();
      if (!['accepted', 'quiescing', 'exporting', 'importing'].includes(current.stage)) throw databaseMaintenanceError();
      const decision = decide(id, previousToken, current.stage, { kind: 'recovery', recoveryToken });
      if (decision.kind === 'recovery') {
        if (decision.recoveryToken !== recoveryToken) throw databaseMaintenanceError();
        break;
      }
      if (read().stage === current.stage) transition(id, previousToken, current.stage, decision.nextStage);
    }
    const directory = workerDirectory(previousToken);
    const fd = openSync(join(directory, 'exit'), 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(directory);
    const next = { id, token: recoveryToken, previousToken };
    const pending = join(activeDir, 'coordinator-' + randomUUID() + '.pending');
    writeDurableExclusive(pending, next);
    try {
      // EEXIST is a lost race unless this is the SAME recorded recovery
      // request. Different claimants must never receive the winning token.
      linkSync(pending, join(activeDir, 'coordinator-after-' + previousToken + '.json'));
    } catch (err) {
      if (err.code !== 'EEXIST' || readCoordinator(id)?.token !== recoveryToken) throw err;
    } finally {
      unlinkSync(pending);
    }
    syncDirectory(activeDir);
    assertCoordinator(id, next.token);
    return next.token;
  };

  const transition = (id, token, expectedStage, nextStage) => {
    assertNotRealDataWrite(activeDir, 'database maintenance transition');
    const current = read();
    if (!current || current.id !== id || !stages.includes(expectedStage)
      || stages.indexOf(nextStage) !== stages.indexOf(expectedStage) + 1) throw databaseMaintenanceError();
    assertCoordinator(id, token);
    // An acknowledged publication may have crashed before returning to its
    // caller. Only that exact owned transition is idempotent, never a reversal.
    if (current.stage === nextStage) {
      syncDirectory(activeDir);
      return current;
    }
    if (current.stage !== expectedStage) throw databaseMaintenanceError();
    // Do not reinterpret interrupted writes from the old publication protocol.
    if (existsSync(join(activeDir, 'stage-' + expectedStage + '.claim'))) throw databaseMaintenanceError();
    const decision = decide(id, token, expectedStage, { kind: 'transition', nextStage });
    if (decision.kind !== 'transition' || decision.nextStage !== nextStage) throw databaseMaintenanceError();
    const next = journalSchema.parse({ ...current, stage: nextStage });
    const pending = join(activeDir, 'publication-' + randomUUID() + '.pending');
    writeDurableExclusive(pending, next);
    try {
      // link is an atomic, no-replace publication of already-fsynced bytes.
      // A competing owner-token retry may win; both describe the same transition.
      linkSync(pending, join(activeDir, 'published-' + nextStage + '.json'));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    } finally {
      unlinkSync(pending);
    }
    syncDirectory(activeDir);
    const published = read();
    if (!published || published.id !== id || stages.indexOf(published.stage) < stages.indexOf(nextStage)) throw databaseMaintenanceError();
    return next;
  };

  const cancel = (id, source) => {
    assertNotRealDataWrite(activeDir, 'database maintenance cancel');
    // A per-operation exclusive cancellation claim prevents two cancellations
    // from renaming a later operation after the first has released this one.
    // An interrupted cancellation leaves this marker and fails closed; it must
    // never be automatically stolen on a timeout or an unverified PID guess.
    const initial = read();
    if (!initial || initial.id !== id) throw new Error('Database maintenance operation does not match.');
    const parsedSource = databaseMaintenanceEndpointSchema.parse(source);
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

  return { isFenced, assertAdmission, read, begin, cancel, acquireCoordinator, transition,
    reserveCoordinatorWorker, coordinatorStatus, recoverCoordinator, assertCoordinatorWorker, enterCoordinatorWorker };
}

const journal = createDatabaseMaintenanceJournal();
export const assertDatabaseAdmission = journal.assertAdmission;
