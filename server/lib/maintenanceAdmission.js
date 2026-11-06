/** Machine-local graceful drain. The same journal fences the server and runner. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs';
import { z } from 'zod';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';
import { createMaintenanceJournal, maintenanceError as error, syncMaintenanceDirectory } from './maintenanceJournal.js';
import { createDeferredUpdateAdmission } from './maintenanceDeferredUpdate.js';
import { createHarnessActionAdmission } from './maintenanceHarnessAction.js';
import { createMaintenanceExclusive, maintenanceExclusiveSchema, maintenanceExclusiveReceiptSchema } from './maintenanceExclusive.js';

export { syncMaintenanceDirectory } from './maintenanceJournal.js';

const operationSchema = z.object({
  id: z.string().uuid(), kind: z.string().min(1), resource: z.string().max(256),
  pid: z.number().int().positive(), startedAt: z.string().datetime(), unsettled: z.boolean().optional(),
  uncertaintyStamp: z.string().uuid().optional(),
}).strict();
export const maintenanceJournalSchema = z.object({
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
export const isMaintenanceHold = err => ['MAINTENANCE_HELD', 'MAINTENANCE_UNAVAILABLE'].includes(err?.code);
export const isOperatorDisposableReservation = op => ['media', 'runner', 'api-run', 'cli-run', 'tui-run', 'manual-run', 'heavy-job',
  'script-job', 'shell-job', 'provider', 'music-video', 'app-operation', 'backup'].includes(op.kind)
  || (op.kind === 'settlement' && op.resource === 'Output publication');

export function createMaintenanceAdmission(dataDir = PATHS.data, { io = fs, assertWrite = assertNotRealDataWrite,
  makeId = randomUUID, now = Date.now, verifyExclusiveReceipt = () => false, harnessAbsent, harnessOwnerPresent, harnessParentPid } = {}) {
  const context = new AsyncLocalStorage();
  const events = new EventEmitter();
  const localOwners = new Map();
  const locallyFinished = new Map();
  const { directory, lock, read, readForStatus, transaction, exists, unavailable, isUncertain, markUncertain } = createMaintenanceJournal(dataDir, {
    io, assertWrite, makeId, validate: value => maintenanceJournalSchema.parse(value),
    // Listener errors must not turn a committed reservation into failed admission.
    changed: () => queueMicrotask(() => { for (const listener of events.listeners('changed')) {
      try { listener(status()); } catch (err) { console.error(`❌ Maintenance notification failed: ${err.message}`); }
    } }),
  });
  const project = state => ({
    state: state.hold ? (state.operations.length || state.exclusive ? 'draining' : 'ready') : 'normal',
    revision: state.revision, hold: state.hold && { ...state.hold },
    blockers: [...state.operations.map(({ kind, resource, startedAt, pid, unsettled }) => ({ kind, resource, startedAt, pid, unsettled })),
      ...(state.exclusive ? [{ kind: 'exclusive-maintenance', resource: state.exclusive.operation.operationId,
        startedAt: state.exclusive.claimedAt, unsettled: state.exclusive.phase === 'uncertain' }] : [])],
    deferredUpdate: deferredUpdate.inspect(state),
    scope: 'PortOS agents, mind turns, provider runs, media renders and scheduled shell/script work, through cleanup and saving. Unrelated host applications are outside this scope.',
  });
  const status = () => {
    let cause = 'unreadable-journal';
    let since;
    try {
      if (exists(lock)) {
        cause = 'interrupted-transaction';
        since = io.lstatSync(lock).mtime.toISOString();
        throw unavailable();
      }
      if (isUncertain()) { cause = 'process-uncertain'; throw unavailable(); }
      return project(readForStatus());
    } catch {
      return { state: 'unavailable', revision: null, hold: null, blockers: [],
        cause, ...(since ? { since } : {}),
        error: 'Maintenance state needs recovery. New work is held; readiness is unknown.' };
    }
  };
  const exclusive = createMaintenanceExclusive({ transaction, read, lockExists: () => exists(lock), makeId, error, now,
    verifyReceipt: verifyExclusiveReceipt });
  const deferredUpdate = createDeferredUpdateAdmission({ transaction, read: readForStatus, makeId, error, now, directory, io,
    syncDirectory: syncMaintenanceDirectory, lockExists: () => exists(lock) });
  const harnessActions = createHarnessActionAdmission({ transaction, read: readForStatus, makeId, error, now,
    absent: harnessAbsent, ownerPresent: harnessOwnerPresent, parentPid: harnessParentPid });
  const held = () => status().state !== 'normal';
  const assertOpen = () => { if (held()) throw error(status().state === 'unavailable' ? 'MAINTENANCE_UNAVAILABLE' : 'MAINTENANCE_HELD'); };
  const currentId = () => context.getStore()?.id ?? null;
  const ownerFor = op => ({ pid: op.pid, startedAt: op.startedAt, generation: op.uncertaintyStamp });
  const sameOwner = (op, owner) => Boolean(op && owner) && op.pid === owner.pid && op.startedAt === owner.startedAt;
  const adopt = op => {
    op.pid = process.pid;
    op.startedAt = new Date(Math.max(Date.now(), Date.parse(op.startedAt) + 1)).toISOString();
    if (op.unsettled && op.uncertaintyStamp) op.uncertaintyStamp = randomUUID();
    return ownerFor(op);
  };
  const admit = (kind, resource = '', { continuation = false, parentId = null, parentKinds = null, reconnect = false, reconnectFinished = false } = {}) => {
    const inheritedId = parentId ?? (continuation ? currentId() : null);
    const inheritedOwner = !parentId && continuation ? context.getStore()?.owner : null;
    let id = makeId();
    let recovery;
    let owner;
    transaction(state => {
      if (inheritedOwner && !state.operations.some(op => op.id === inheritedId && sameOwner(op, inheritedOwner)))
        throw error('MAINTENANCE_HELD', 'The admitted parent operation has already settled.');
      const inherited = inheritedId && state.operations.some(op => op.id === inheritedId && (!op.unsettled || kind === 'settlement')
        && (!parentKinds || parentKinds.includes(op.kind)) && (!inheritedOwner || sameOwner(op, inheritedOwner)));
      if (state.hold && !inherited) throw error();
      // An explicitly supplied expired parent must never become new work.
      if (parentId && !inherited) throw error('MAINTENANCE_HELD', 'The admitted parent operation has already settled.');
      // Reconciliation may submit an idempotent replay, so it still obeys the
      // admission fence above; reuse ownership only after that fence passes.
      const existing = (reconnect || reconnectFinished) && state.operations.find(op => op.kind === kind && op.resource === resource
        && (!reconnectFinished || isLocallyFinished(op)));
      if (existing) {
        id = existing.id; owner = adopt(existing); recovery = recoverySnapshot(existing); return;
      }
      const operation = { id, kind, resource, pid: process.pid, startedAt: new Date().toISOString() };
      state.operations.push(operation); owner = ownerFor(operation);
    });
    localOwners.set(id, owner);
    locallyFinished.delete(id);
    return permitFor(id, recovery, owner);
  };
  // A capability binds one previously observed operation, including every
  // uncertainty mark made before reconciliation. A legacy unsettled record
  // has no stamp to compare and cannot be completed through this capability.
  const recoverySnapshot = op => Object.freeze({ id: op.id, kind: op.kind, resource: op.resource, pid: op.pid, startedAt: op.startedAt,
    unsettled: op.unsettled === true, uncertaintyStamp: op.uncertaintyStamp });
  const completeRecovery = expected => {
    if (expected.unsettled && !expected.uncertaintyStamp) return false;
    return transaction(state => {
      const index = state.operations.findIndex(op => op.id === expected.id && op.kind === expected.kind
        && op.resource === expected.resource && op.pid === expected.pid && op.startedAt === expected.startedAt
        && (op.unsettled === true) === expected.unsettled
        && op.uncertaintyStamp === expected.uncertaintyStamp);
      if (index < 0) return false;
      state.operations.splice(index, 1);
      return true;
    });
  };
  // Local owning-service recovery after explicit operator disposition of a
  // legacy pre-admission refusal. The service must preserve inspected evidence
  // in publish(), durably and replayably, before this exact owner is retired.
  const reconcilePublicationRefusal = ({ hold, expected, publish, replay }) => transaction(state => {
    if (!hold || state.hold?.id !== hold.id || state.hold?.revision !== hold.revision || state.exclusive)
      throw error('MAINTENANCE_STALE', 'The maintenance hold changed.');
    if (expected?.kind !== 'settlement' || expected.resource !== 'Output publication'
      || expected.unsettled !== true || !expected.uncertaintyStamp)
      throw error('MAINTENANCE_STALE', 'An exact uncertain publication reservation is required.');
    const index = state.operations.findIndex(op => op.id === expected.id);
    if (index < 0) return replay();
    if (JSON.stringify(state.operations[index]) !== JSON.stringify(expected))
      throw error('MAINTENANCE_STALE', 'The publication reservation changed.');
    const receipt = publish();
    state.operations.splice(index, 1);
    return receipt;
  });
  const permitFor = (id, recovery, owner) => ({
    id,
    run: fn => context.run({ id, owner }, fn),
    finish: () => finish(id, owner),
    isCurrent: () => localOwners.get(id) === owner && read().operations.some(op => op.id === id && sameOwner(op, owner)),
    markUnsettled: () => {
      if (localOwners.get(id) === owner) markUnsettled(op => op.id === id && sameOwner(op, owner));
    },
    identify: resource => transaction(state => {
      const op = state.operations.find(op => op.id === id);
      if (op && localOwners.get(id) === owner && sameOwner(op, owner)) op.resource = resource;
    }),
    ...(recovery ? { completeRecovery: () => localOwners.get(id) === owner && completeRecovery(recovery) } : {}),
  });
  // Trusted recovery only: this records observed existing work, never starts it.
  const recoverOwned = (kind, resource, { observeIfOwned = false } = {}) => {
    let recovery;
    let owner;
    const id = transaction(state => {
      const existing = state.operations.find(op => op.kind === kind && op.resource === resource);
      if (existing) {
        const current = localOwners.get(existing.id);
        owner = observeIfOwned && current && !locallyFinished.has(existing.id) && sameOwner(existing, current) ? current : adopt(existing);
        recovery = recoverySnapshot(existing); return existing.id;
      }
      const id = makeId();
      exclusive.observeExistingWork(state);
      harnessActions.observeExistingWork(state);
      const operation = { id, kind, resource, pid: process.pid, startedAt: new Date().toISOString() };
      state.operations.push(operation); owner = ownerFor(operation);
      return id;
    });
    localOwners.set(id, owner);
    locallyFinished.delete(id);
    return permitFor(id, recovery, owner);
  };
  const tryAdmit = (...args) => { try { return admit(...args); } catch (err) { if (isMaintenanceHold(err)) return null; throw err; } };
  const finishing = new Map();
  const finish = (id, owner = localOwners.get(id), { observed = false } = {}) => {
    const existing = finishing.get(id);
    if (existing?.owner === owner) return existing.pending;
    // A runner and server can finish in the same millisecond. Contention is
    // retried; never lose a completion solely because another writer owns mkdir.
    const settle = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          if (owner && !observed && localOwners.get(id) !== owner) return false;
          const result = transaction(state => {
            const operation = state.operations.find(op => op.id === id);
            if (owner && operation && !sameOwner(operation, owner)) return { stale: true };
            state.operations = state.operations.filter(op => op.id !== id || op.unsettled);
            return { retained: operation?.pid === process.pid && operation.unsettled === true, generation: operation?.uncertaintyStamp };
          });
          if (result.stale) return false;
          if (owner && localOwners.get(id) === owner) {
            if (result.retained) locallyFinished.set(id, { owner, generation: result.generation });
            else { locallyFinished.delete(id); localOwners.delete(id); }
          }
          return true;
        } catch {
          if (isUncertain() || !exists(lock)) break;
          await new Promise(resolve => { const timer = setTimeout(resolve, 50); timer.unref?.(); });
        }
      }
      console.error('❌ Maintenance settlement needs recovery; preserving its blocker.');
      if (owner && localOwners.get(id) === owner) locallyFinished.set(id, { owner, generation: owner.generation });
      return false;
    };
    const pending = settle().finally(() => { if (finishing.get(id)?.pending === pending) finishing.delete(id); });
    finishing.set(id, { owner, pending });
    return pending;
  };
  // Only trusted lifecycle code calls this after terminal persistence/cleanup.
  // A server restarted during a runner job can finish the old owner's record.
  const resourceOperations = (kind, resource) => read().operations.filter(op => op.kind === kind && op.resource === resource);
  const finishResource = (kind, resource) => {
    const active = context.getStore();
    return Promise.all(resourceOperations(kind, resource).map(op => {
      const local = localOwners.get(op.id);
      const owner = active?.id === op.id ? active.owner : local && sameOwner(op, local) ? local : ownerFor(op);
      return finish(op.id, owner, { observed: true });
    }));
  };
  const withResource = (kind, resource, fn) => {
    const operation = resourceOperations(kind, resource).find(op => !op.unsettled);
    const local = operation && localOwners.get(operation.id);
    const owner = operation && local && sameOwner(operation, local) ? local : operation && ownerFor(operation);
    return operation ? context.run({ id: operation.id, owner }, fn) : fn();
  };
  const markUnsettled = matches => {
    try {
      const updates = transaction(state => {
        const changed = [];
        for (const op of state.operations) if (matches(op)) {
          op.unsettled = true;
          op.uncertaintyStamp = randomUUID();
          changed.push({ id: op.id, pid: op.pid, startedAt: op.startedAt, generation: op.uncertaintyStamp });
        }
        return changed;
      });
      for (const update of updates) {
        const owner = localOwners.get(update.id);
        if (owner && owner.pid === update.pid && owner.startedAt === update.startedAt)
          owner.generation = update.generation;
        const active = context.getStore();
        if (active?.id === update.id && active.owner?.pid === update.pid && active.owner.startedAt === update.startedAt)
          active.owner.generation = update.generation;
        locallyFinished.delete(update.id);
      }
    }
    catch { markUncertain(); console.error('❌ Maintenance recovery record could not be saved; readiness remains unknown.'); }
  };
  const markResourceUnsettled = (kind, resource) => markUnsettled(op => op.kind === kind && op.resource === resource);
  const markCurrentUnsettled = () => {
    const { id, owner } = context.getStore() ?? {};
    if (id && owner) markUnsettled(op => op.id === id && sameOwner(op, owner));
  };
  // A publication boundary may prove its callback never started. Keep the
  // reservation while it waits, but do not mistake refused admission for an
  // uncertain write. Callers without that proof retain the conservative default.
  // Background work (an event listener, a fire-and-forget hash) can outlive the
  // operation whose async context it inherited. Once that reservation is gone the
  // work is detached, exactly like work with no ambient operation: running it
  // through a dead parent would only throw "parent already settled".
  const ambientOperationLive = () => {
    const { id, owner } = context.getStore() ?? {};
    return Boolean(id) && read().operations.some(op => op.id === id && sameOwner(op, owner));
  };
  const continueSettlement = (fn, { hasStarted } = {}) => ambientOperationLive()
    ? run('settlement', 'Output publication', fn, { continuation: true, hasStarted }) : fn();
  const run = async (kind, resource, fn, options) => {
    const permit = admit(kind, resource, options);
    try { return await permit.run(fn); }
    catch (err) {
      if (kind === 'settlement') {
        let started = true;
        try { started = options?.hasStarted?.() !== false; } catch { /* Missing proof remains uncertain. */ }
        if (started) permit.markUnsettled();
      }
      throw err;
    }
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
      if (deferredUpdate.inspect(state)?.holdId === expected.id)
        throw error('MAINTENANCE_STALE', 'The update owns this hold until its processes settle.');
      if (harnessActions.inspect(state)?.holdId === expected.id)
        throw error('MAINTENANCE_STALE', 'The harness action owns this hold until its processes settle.');
      if (state.exclusive)
        throw error('MAINTENANCE_STALE', 'An exclusive maintenance operation owns this hold until verified reconciliation.');
      state.hold = null;
    });
    return status();
  };
  // Cached read-only snapshot for trusted reconcilers (runs on every zombie sweep); releaseOperations re-verifies under the lock.
  const operations = () => readForStatus().operations.map(op => ({ ...op }));
  // Removes only settled records still identical to what the caller inspected;
  // anything that changed (or settled elsewhere) since then is left alone.
  const releaseOperations = expected => transaction(state => {
    const before = state.operations.length;
    state.operations = state.operations.filter(op => op.unsettled
      || !expected.some(seen => seen.id === op.id && seen.kind === op.kind
        && seen.resource === op.resource && seen.pid === op.pid && seen.startedAt === op.startedAt));
    return before - state.operations.length;
  });
  // Fail-closed stamp for records the caller already inspected. Already-unsettled
  // rows keep their stamp: rotating it would invalidate an operator receipt in flight.
  const markOperationsUncertain = expected => transaction(state => {
    let marked = 0;
    for (const op of state.operations) {
      if (op.unsettled) continue;
      const seen = expected.some(item => item.id === op.id && item.kind === op.kind
        && item.resource === op.resource && item.pid === op.pid && item.startedAt === op.startedAt);
      if (!seen) continue;
      op.unsettled = true;
      op.uncertaintyStamp = randomUUID();
      marked += 1;
    }
    return marked;
  });
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
  // The operator's receipt preserves the exact reservations and explicitly
  // records unknown output. It does not settle a release-candidate obligation.
  const reconcileInactiveReservations = ({ hold, update, revision, expected, ordinaryAgentIds = [], validate, publish, replay }) => {
    const result = transaction(state => {
    if (update) {
      const owner = deferredUpdate.inspect(state);
      if (state.hold || state.exclusive || !owner || owner.id !== update.id || owner.ownerPid !== update.ownerPid
        || owner.requestedAt !== update.requestedAt || owner.phase !== 'waiting' || owner.childPid || owner.holdId)
        throw error('MAINTENANCE_STALE', 'The waiting update changed.');
    } else if (!hold || state.hold?.id !== hold.id || state.hold?.revision !== hold.revision || state.exclusive
      || !['Operator session', 'Local operator'].includes(state.hold.owner))
      throw error('MAINTENANCE_STALE', 'The maintenance hold changed or is exclusively owned.');
    if (state.revision !== revision)
      throw error('MAINTENANCE_STALE', 'Work changed during the activity check. Inspect it again.');
    if (!expected.length || new Set(expected.map(op => op.id)).size !== expected.length || expected.some(op =>
      !isOperatorDisposableReservation(op) && !(update && op.kind === 'agent' && ordinaryAgentIds.includes(op.id))))
      throw error('MAINTENANCE_STALE', 'Select only supported, distinct reservations.');
    const current = expected.map(op => state.operations.find(row => row.id === op.id));
    if (current.every(op => !op)) return replay();
    if (current.some((op, index) => !op || !isDeepStrictEqual(op, expected[index])))
      throw error('MAINTENANCE_STALE', 'The reservation inventory changed. Inspect it again.');
    validate(state.operations);
    const receipt = publish();
    const ids = new Set(expected.map(op => op.id));
    state.operations = state.operations.filter(op => !ids.has(op.id));
    return receipt;
    });
    for (const op of expected) { locallyFinished.delete(op.id); localOwners.delete(op.id); }
    return result;
  };
  const isLocallyFinished = op => {
    const finished = locallyFinished.get(op?.id);
    return Boolean(finished) && op?.pid === process.pid && finished.owner === localOwners.get(op.id)
      && sameOwner(op, finished.owner) && finished?.generation === op.uncertaintyStamp;
  };
  const assertCurrent = () => {
    const { id, owner } = context.getStore() ?? {};
    if (!id || !owner || localOwners.get(id) !== owner || !read().operations.some(op => op.id === id && sameOwner(op, owner)
      && !isLocallyFinished(op)))
      throw error('MAINTENANCE_HELD', 'Existing work ownership is no longer current.');
  };
  const { observeIdle, claimReady, getExclusive, transitionExclusive, settleExclusive, issueExecutionCapability } = exclusive;
  return { deferredUpdate, harnessActions, directory, status, held, assertOpen, admit, tryAdmit, recoverOwned, reconcilePublicationRefusal, operations, releaseOperations, markOperationsUncertain, run, currentId, finish, finishResource, withResource, markResourceUnsettled, markCurrentUnsettled, continueSettlement, begin, resume, events,
    observeIdle, claimReady, getExclusive, transitionExclusive, settleExclusive, issueExecutionCapability, reconcileAbandonedAgent, reconcileInactiveReservations, isLocallyFinished, assertCurrent };
}

// Resolve the configured data root on first use, after host/test setup.
let defaultAdmission;
export const maintenance = new Proxy({}, {
  get(_target, property) {
    defaultAdmission ??= createMaintenanceAdmission();
    return defaultAdmission[property];
  },
});
