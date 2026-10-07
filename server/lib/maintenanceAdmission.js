/** Machine-local graceful drain. The same journal fences the server and runner. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';
import { createMaintenanceExclusive, maintenanceExclusiveSchema, maintenanceExclusiveReceiptSchema } from './maintenanceExclusive.js';

const operationSchema = z.object({
  id: z.string().uuid(), kind: z.string().min(1), resource: z.string().max(256),
  pid: z.number().int().positive(), startedAt: z.string().datetime(), unsettled: z.boolean().optional(),
  uncertaintyStamp: z.string().uuid().optional(),
}).strict();
const schema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  hold: z.object({ id: z.string().uuid(), revision: z.number().int().positive(),
    reason: z.string().min(1).max(500), owner: z.string().min(1).max(128), requestedAt: z.string().datetime(),
  }).strict().nullable(),
  operations: z.array(operationSchema),
  exclusive: maintenanceExclusiveSchema.nullable().optional(),
  exclusiveReceipt: maintenanceExclusiveReceiptSchema.optional(),
}).strict().refine(state => !state.exclusive || (state.hold?.id === state.exclusive.holdId
  && state.hold?.revision === state.exclusive.holdRevision));
export const maintenanceBeginSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const maintenanceResumeSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();
const empty = () => ({ version: 1, revision: 0, hold: null, operations: [] });
const error = (code = 'MAINTENANCE_HELD', message = 'Maintenance is holding new work. Existing work can finish.') =>
  Object.assign(new Error(message), { status: code === 'MAINTENANCE_STALE' ? 409 : 503, code });
export const isMaintenanceHold = err => ['MAINTENANCE_HELD', 'MAINTENANCE_UNAVAILABLE'].includes(err?.code);

function syncDirectory(path, io) {
  if (process.platform === 'win32') return;
  const fd = io.openSync(path, 'r');
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}

export function createMaintenanceAdmission(dataDir = PATHS.data, { io = fs, assertWrite = assertNotRealDataWrite,
  makeId = randomUUID, now = Date.now, verifyExclusiveReceipt = () => false } = {}) {
  const directory = join(dataDir, 'workflow-maintenance');
  const file = join(directory, 'state.json');
  const lock = join(directory, 'transaction');
  const context = new AsyncLocalStorage();
  const events = new EventEmitter();
  // A failed publication must not reopen admission in this process, even if
  // an operator removes an interrupted transaction before restarting it.
  let uncertain = false;
  const unavailable = () => error('MAINTENANCE_UNAVAILABLE', 'Maintenance state needs recovery; new work remains held.');
  const exists = path => {
    try { io.lstatSync(path); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  };
  const read = () => {
    if (uncertain) throw unavailable();
    try {
      if (!exists(file)) return empty();
      if (!io.lstatSync(file).isFile()) throw unavailable();
      return schema.parse(JSON.parse(io.readFileSync(file, 'utf8')));
    } catch { throw unavailable(); }
  };
  const project = state => ({
    state: state.hold ? (state.operations.length || state.exclusive ? 'draining' : 'ready') : 'normal',
    revision: state.revision, hold: state.hold,
    blockers: [...state.operations.map(({ kind, resource, startedAt, pid, unsettled }) => ({ kind, resource, startedAt, pid, unsettled })),
      ...(state.exclusive ? [{ kind: 'exclusive-maintenance', resource: state.exclusive.operation.operationId,
        startedAt: state.exclusive.claimedAt, unsettled: state.exclusive.phase === 'uncertain' }] : [])],
    scope: 'PortOS agents, mind turns, provider runs, media renders and scheduled shell/script work, through cleanup and saving. Unrelated host applications are outside this scope.',
  });
  const status = () => {
    try {
      if (exists(lock)) throw unavailable();
      return project(read());
    } catch {
      return { state: 'unavailable', revision: null, hold: null, blockers: [],
        error: 'Maintenance state needs recovery. New work is held; readiness is unknown.' };
    }
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
    } catch { throw unavailable(); }
    let published = false;
    let result;
    try {
      const state = read();
      result = change(state);
      state.revision++;
      schema.parse(state);
      const pending = join(directory, `pending-${makeId()}.json`);
      const fd = io.openSync(pending, 'wx', 0o600);
      try { io.writeFileSync(fd, JSON.stringify(state) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      io.renameSync(pending, file);
      syncDirectory(directory, io);
      published = true;
    } catch (err) {
      // Refused admission/stale requests didn't attempt a publication.
      if (['MAINTENANCE_HELD', 'MAINTENANCE_STALE'].includes(err.code)) published = true;
      else uncertain = true;
      throw err.code?.startsWith('MAINTENANCE_') ? err : unavailable();
    } finally {
      if (published) {
        try { io.rmdirSync(lock); syncDirectory(directory, io); } catch { uncertain = true; }
      }
    }
    if (uncertain) throw unavailable();
    // Listener errors must never turn a committed reservation into a failed
    // admission whose caller cannot own/release it.
    queueMicrotask(() => { for (const listener of events.listeners('changed')) {
      try { listener(status()); } catch (err) { console.error(`❌ Maintenance notification failed: ${err.message}`); }
    } });
    return result;
  };
  const exclusive = createMaintenanceExclusive({ transaction, read, lockExists: () => exists(lock), makeId, error, now,
    verifyReceipt: verifyExclusiveReceipt });
  const held = () => status().state !== 'normal';
  const assertOpen = () => { if (held()) throw error(status().state === 'unavailable' ? 'MAINTENANCE_UNAVAILABLE' : 'MAINTENANCE_HELD'); };
  const currentId = () => context.getStore() ?? null;
  const admit = (kind, resource = '', { continuation = false, parentId = null, parentKinds = null, reconnect = false } = {}) => {
    const inheritedId = parentId ?? (continuation ? currentId() : null);
    let id = makeId();
    let recovery;
    transaction(state => {
      const inherited = inheritedId && state.operations.some(op => op.id === inheritedId && (!op.unsettled || kind === 'settlement') && (!parentKinds || parentKinds.includes(op.kind)));
      if (state.hold && !inherited) throw error();
      // An explicitly supplied expired parent must never become new work.
      if (parentId && !inherited) throw error('MAINTENANCE_HELD', 'The admitted parent operation has already settled.');
      // Reconciliation may submit an idempotent replay, so it still obeys the
      // admission fence above; reuse ownership only after that fence passes.
      const existing = reconnect && state.operations.find(op => op.kind === kind && op.resource === resource);
      if (existing) { id = existing.id; recovery = recoverySnapshot(existing); return; }
      state.operations.push({ id, kind, resource, pid: process.pid, startedAt: new Date().toISOString() });
    });
    return permitFor(id, recovery);
  };
  // A capability binds one previously observed operation, including every
  // uncertainty mark made before reconciliation. A legacy unsettled record
  // has no stamp to compare and cannot be completed through this capability.
  const recoverySnapshot = op => Object.freeze({ id: op.id, kind: op.kind, resource: op.resource,
    unsettled: op.unsettled === true, uncertaintyStamp: op.uncertaintyStamp });
  const completeRecovery = expected => {
    if (expected.unsettled && !expected.uncertaintyStamp) return false;
    return transaction(state => {
      const index = state.operations.findIndex(op => op.id === expected.id && op.kind === expected.kind
        && op.resource === expected.resource && (op.unsettled === true) === expected.unsettled
        && op.uncertaintyStamp === expected.uncertaintyStamp);
      if (index < 0) return false;
      state.operations.splice(index, 1);
      return true;
    });
  };
  const permitFor = (id, recovery) => ({
    id,
    run: fn => context.run(id, fn),
    finish: () => finish(id),
    markUnsettled: () => markUnsettled(op => op.id === id),
    identify: resource => transaction(state => { const op = state.operations.find(op => op.id === id); if (op) op.resource = resource; }),
    ...(recovery ? { completeRecovery: () => completeRecovery(recovery) } : {}),
  });
  // Trusted recovery only: this records observed existing work, never starts it.
  const recoverOwned = (kind, resource) => {
    let recovery;
    const id = transaction(state => {
      const existing = state.operations.find(op => op.kind === kind && op.resource === resource);
      if (existing) { recovery = recoverySnapshot(existing); return existing.id; }
      const id = makeId();
      exclusive.observeExistingWork(state);
      state.operations.push({ id, kind, resource, pid: process.pid, startedAt: new Date().toISOString() });
      return id;
    });
    return permitFor(id, recovery);
  };
  const tryAdmit = (...args) => { try { return admit(...args); } catch (err) { if (isMaintenanceHold(err)) return null; throw err; } };
  const finishing = new Map();
  const finish = id => {
    if (finishing.has(id)) return finishing.get(id);
    // A runner and server can finish in the same millisecond. Contention is
    // retried; never lose a completion solely because another writer owns mkdir.
    const settle = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          transaction(state => { state.operations = state.operations.filter(op => op.id !== id || op.unsettled); });
          return true;
        } catch {
          if (uncertain || !exists(lock)) break;
          await new Promise(resolve => { const timer = setTimeout(resolve, 50); timer.unref?.(); });
        }
      }
      console.error('❌ Maintenance settlement needs recovery; preserving its blocker.');
      return false;
    };
    const pending = settle().finally(() => finishing.delete(id));
    finishing.set(id, pending);
    return pending;
  };
  // Only trusted lifecycle code calls this after terminal persistence/cleanup.
  // A server restarted during a runner job can finish the old owner's record.
  const resourceOperations = (kind, resource) => read().operations.filter(op => op.kind === kind && op.resource === resource);
  const finishResource = (kind, resource) => Promise.all(resourceOperations(kind, resource).map(op => finish(op.id)));
  const withResource = (kind, resource, fn) => {
    const operation = resourceOperations(kind, resource).find(op => !op.unsettled);
    return operation ? context.run(operation.id, fn) : fn();
  };
  const markUnsettled = matches => {
    try { transaction(state => { for (const op of state.operations) if (matches(op)) {
      op.unsettled = true;
      op.uncertaintyStamp = randomUUID();
    } }); }
    catch { uncertain = true; console.error('❌ Maintenance recovery record could not be saved; readiness remains unknown.'); }
  };
  const markResourceUnsettled = (kind, resource) => markUnsettled(op => op.kind === kind && op.resource === resource);
  const markCurrentUnsettled = () => {
    const id = currentId();
    if (id) markUnsettled(op => op.id === id);
  };
  const continueSettlement = fn => currentId() ? run('settlement', 'Output publication', fn, { continuation: true }) : fn();
  const run = async (kind, resource, fn, options) => {
    const permit = admit(kind, resource, options);
    try { return await permit.run(fn); }
    catch (err) { if (kind === 'settlement') permit.markUnsettled(); throw err; }
    finally { await permit.finish(); }
  };
  const begin = ({ reason, owner }) => {
    const input = maintenanceBeginSchema.parse({ reason });
    transaction(state => {
      if (state.hold) throw error('MAINTENANCE_STALE', 'A maintenance hold already exists. Refresh its status.');
      state.hold = { id: makeId(), revision: state.revision + 1, ...input, owner,
        requestedAt: new Date().toISOString() };
    });
    return status();
  };
  const resume = input => {
    const expected = maintenanceResumeSchema.parse(input);
    transaction(state => {
      if (state.hold?.id !== expected.id || state.hold?.revision !== expected.revision)
        throw error('MAINTENANCE_STALE', 'This maintenance hold changed. Refresh before resuming.');
      if (state.exclusive)
        throw error('MAINTENANCE_STALE', 'An exclusive maintenance operation owns this hold until verified reconciliation.');
      state.hold = null;
    });
    return status();
  };
  // Owning-service recovery only. Validation and durable receipt publication
  // run under the same journal lock as the exact reservation removal.
  const reconcileAbandonedAgent = ({ hold, agentId, validate, publish, replay }) => transaction(state => {
    if (state.hold?.id !== hold.id || state.hold?.revision !== hold.revision || state.exclusive)
      throw error('MAINTENANCE_STALE', 'The recovery hold changed or is exclusively owned.');
    const matches = state.operations.filter(op => op.resource === agentId);
    if (matches.length === 0) return replay();
    if (matches.length !== 1 || matches[0].kind !== 'agent' || matches[0].unsettled)
      throw error('MAINTENANCE_STALE', 'Recovery requires exactly one settled agent reservation.');
    const operation = { ...matches[0] };
    validate(operation);
    const receipt = publish(operation);
    state.operations = state.operations.filter(op => op.id !== operation.id);
    return receipt;
  });
  const { observeIdle, claimReady, getExclusive, transitionExclusive, settleExclusive, issueExecutionCapability } = exclusive;
  return { directory, status, held, assertOpen, admit, tryAdmit, recoverOwned, run, currentId, finish, finishResource, withResource, markResourceUnsettled, markCurrentUnsettled, continueSettlement, begin, resume, events,
    observeIdle, claimReady, getExclusive, transitionExclusive, settleExclusive, issueExecutionCapability, reconcileAbandonedAgent };
}

// Resolve the configured data root on first use, after host/test setup.
let defaultAdmission;
export const maintenance = new Proxy({}, {
  get(_target, property) {
    defaultAdmission ??= createMaintenanceAdmission();
    return defaultAdmission[property];
  },
});
