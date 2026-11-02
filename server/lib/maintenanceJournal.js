/** Dependency-free transaction shared with the updater while npm replaces dependencies. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';

export const maintenanceError = (code = 'MAINTENANCE_HELD', message = 'Maintenance is holding new work. Existing work can finish.') =>
  Object.assign(new Error(message), { status: code === 'MAINTENANCE_STALE' ? 409 : 503, code });
const error = maintenanceError;
const empty = () => ({ version: 1, revision: 0, hold: null, operations: [] });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));

// Bootstrap owns only rows and the ordinary hold. Foreign exclusive records
// remain opaque and preserved; their presence prevents local acquisition.
// Server callers additionally supply the full peer/exclusive Zod validator.
const parseJournal = state => {
  const valid = keys(state, ['version', 'revision', 'hold', 'operations', 'exclusive', 'exclusiveReceipt'])
    && state.version === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0
    && (state.hold === null || (keys(state.hold, ['id', 'revision', 'reason', 'owner', 'requestedAt'])
      && uuid(state.hold.id) && integer(state.hold.revision) && text(state.hold.reason, 1, 500)
      && text(state.hold.owner, 1, 128) && date(state.hold.requestedAt)))
    && Array.isArray(state.operations) && state.operations.every(op =>
      keys(op, ['id', 'kind', 'resource', 'pid', 'startedAt', 'unsettled', 'uncertaintyStamp'])
      && uuid(op.id) && text(op.kind, 1, Infinity) && text(op.resource, 0, 256)
      && integer(op.pid) && date(op.startedAt) && (op.unsettled === undefined || typeof op.unsettled === 'boolean')
      && (op.uncertaintyStamp === undefined || uuid(op.uncertaintyStamp)))
    && (state.exclusive == null || (record(state.exclusive) && state.hold
      && state.exclusive.holdId === state.hold.id && state.exclusive.holdRevision === state.hold.revision))
    && (state.exclusiveReceipt === undefined || record(state.exclusiveReceipt));
  if (!valid) throw new Error('Invalid maintenance journal');
  return state;
};

export function syncMaintenanceDirectory(path, io = fs) {
  if (process.platform === 'win32') return;
  const fd = io.openSync(path, 'r');
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}

export function createMaintenanceJournal(dataDir = PATHS.data, { io = fs, assertWrite = assertNotRealDataWrite,
  makeId = randomUUID, validate = parseJournal, changed = () => {} } = {}) {
  const directory = join(dataDir, 'workflow-maintenance');
  const file = join(directory, 'state.json');
  const lock = join(directory, 'transaction');
  // A failed publication must not reopen admission in this process, even if
  // an operator removes an interrupted transaction before restarting it.
  let uncertain = false;
  let failureReported = false;
  const reportFailure = err => {
    if (failureReported) return;
    failureReported = true;
    while (err.cause instanceof Error) err = err.cause;
    console.error(`❌ Maintenance transaction failed (${err.code ?? 'UNKNOWN'}): ${String(err.message).replace(/\s+/g, ' ')}`);
  };
  const unavailable = cause => Object.assign(error('MAINTENANCE_UNAVAILABLE', 'Maintenance state needs recovery; new work remains held.'), cause ? { cause } : {});
  const exists = path => {
    try { io.lstatSync(path); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  };
  const read = () => {
    if (uncertain) throw unavailable();
    try {
      if (!exists(file)) return empty();
      if (!io.lstatSync(file).isFile()) throw unavailable();
      return validate(JSON.parse(io.readFileSync(file, 'utf8')));
    } catch (err) { throw unavailable(err); }
  };
  // status()/held() are polled several times a second (media drain loop, spawn
  // gates); re-parsing a journal that carries every settled operation allocated
  // ~400 KB per call. Writers publish by renaming a new file into place, so any
  // change gives it a new identity; the stat is taken before the read, so a
  // racing publish can only cost a re-parse. Read-only: transactions mutate the
  // state they read and must keep calling read() for a private copy.
  let statusCache = null;
  const readForStatus = () => {
    if (uncertain) throw unavailable();
    let stats;
    try { stats = io.lstatSync(file); }
    catch (err) { if (err.code === 'ENOENT') return empty(); throw unavailable(err); }
    if (!stats.isFile()) throw unavailable();
    const key = `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    if (statusCache?.key !== key) statusCache = { key, state: read() };
    return statusCache.state;
  };
  // Synchronous mkdir + read/replace is the shared linearization point. Never
  // steal this lock by age/PID: a crash or failed fsync stays fail-closed.
  const transaction = change => {
    assertWrite(directory, 'workflow maintenance transaction');
    if (uncertain) throw unavailable();
    try {
      io.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Writers do no async work while holding this lock. Same-process calls
      // cannot contend; briefly yield the CPU to a competing server/runner.
      // A crashed writer remains closed, rather than stealing its lock.
      for (let attempt = 0; ; attempt++) {
        try { io.mkdirSync(lock, { mode: 0o700 }); break; }
        catch (err) {
          if (err.code !== 'EEXIST' || attempt === 99) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
    } catch (err) { reportFailure(err); throw unavailable(); }
    let published = false;
    let result;
    try {
      const state = read();
      result = change(state);
      state.revision++;
      validate(state);
      const pending = join(directory, `pending-${makeId()}.json`);
      const fd = io.openSync(pending, 'wx', 0o600);
      try { io.writeFileSync(fd, JSON.stringify(state) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      io.renameSync(pending, file);
      syncMaintenanceDirectory(directory, io);
      published = true;
    } catch (err) {
      // Refused admission/stale requests didn't attempt a publication.
      if (['MAINTENANCE_HELD', 'MAINTENANCE_STALE'].includes(err.code)) published = true;
      else { uncertain = true; reportFailure(err); }
      throw err.code?.startsWith('MAINTENANCE_') ? err : unavailable();
    } finally {
      if (published) {
        try { io.rmdirSync(lock); syncMaintenanceDirectory(directory, io); }
        catch (err) { uncertain = true; reportFailure(err); }
      }
    }
    if (uncertain) throw unavailable();
    changed();
    return result;
  };
  return { directory, lock, read, readForStatus, transaction, exists, unavailable, isUncertain: () => uncertain, markUncertain: () => { uncertain = true; } };
}
