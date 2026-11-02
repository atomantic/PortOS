/** Harness lifecycle ownership in the same journal that admits PortOS work. */
import { processAbsent } from './maintenanceDeferredUpdate.js';

const KIND = 'harness-action';
const WAKE_KIND = 'harness-action-wake';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const pid = value => Number.isSafeInteger(value) && value > 0;
const actions = new Set(['install', 'update', 'uninstall']);
const runtime = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
const processPresent = value => {
  try { process.kill(value, 0); return true; } catch { return false; }
};

// Only a closed set of fields is persisted. This fits the journal's existing
// operation schema, so the runner's dependency-free reader can retain it.
function parse(row) {
  if (!row) return null;
  const details = JSON.parse(row.resource);
  if (!details || typeof details !== 'object' || Array.isArray(details)
    || Object.keys(details).some(key => !['phase', 'childPid', 'holdId', 'holdRevision', 'action', 'runtime', 'invalidated', 'overlap'].includes(key))
    || !['starting', 'entered', 'running'].includes(details.phase)
    || (details.childPid !== null && !pid(details.childPid))
    || (details.holdId !== null && !uuid(details.holdId))
    || (details.holdId === null ? details.holdRevision !== null : !pid(details.holdRevision))
    || !actions.has(details.action) || !runtime(details.runtime)
    || ['invalidated', 'overlap'].some(key => details[key] !== undefined && details[key] !== true)
    || (details.phase !== 'starting' && !pid(details.childPid))
    || (details.phase === 'starting' && details.childPid !== null)) throw new Error('Invalid harness action owner');
  return { id: row.id, ownerPid: row.pid, requestedAt: row.startedAt, ...details };
}

export function createHarnessActionAdmission({ transaction, read, makeId, error, now = Date.now, absent = processAbsent,
  ownerPresent = processPresent, parentPid = () => process.ppid }) {
  const stale = message => { throw error('MAINTENANCE_STALE', message || 'The harness action ownership changed.'); };
  const inspect = state => {
    const rows = state.operations.filter(op => op.kind === KIND);
    if (rows.length > 1) throw error('MAINTENANCE_UNAVAILABLE', 'Multiple harness action owners need recovery.');
    return parse(rows[0]);
  };
  const current = (state, id) => {
    const operation = inspect(state);
    return operation?.id === id ? operation : stale();
  };
  const save = (state, operation) => {
    const { id, ownerPid, requestedAt, ...details } = operation;
    const row = { id, kind: KIND, pid: ownerPid, startedAt: requestedAt, resource: JSON.stringify(details) };
    const index = state.operations.findIndex(op => op.id === id);
    if (index < 0) state.operations.push(row);
    else state.operations[index] = row;
  };
  const sameHold = (state, op) => !op.holdId || (state.hold?.id === op.holdId && state.hold.revision === op.holdRevision);
  const settle = (state, op) => {
    if (!sameHold(state, op)) stale();
    state.operations = state.operations.filter(row => row.id !== op.id);
    if (op.holdId) {
      state.hold = null;
      // Preserve the wake obligation across a crash after releasing the hold.
      state.operations.push({ id: op.id, kind: WAKE_KIND, pid: op.ownerPid, startedAt: op.requestedAt,
        resource: JSON.stringify({ action: op.action, runtime: op.runtime, ...(op.overlap ? { overlap: true } : {}) }) });
    }
    return { id: op.id, held: Boolean(op.holdId), overlap: op.overlap === true, action: op.action, runtime: op.runtime };
  };
  const operation = () => inspect(read());
  const parseWake = row => {
    const value = JSON.parse(row.resource);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['action', 'runtime', 'overlap', 'reported', 'woken'].includes(key))
      || !actions.has(value.action) || !runtime(value.runtime)
      || ['overlap', 'reported', 'woken'].some(key => value[key] !== undefined && value[key] !== true))
      throw error('MAINTENANCE_UNAVAILABLE', 'Harness wake evidence needs recovery.');
    return { id: row.id, ...value };
  };
  const pendingWake = () => read().operations.filter(row => row.kind === WAKE_KIND).map(parseWake);
  const markWakeProgress = (id, { reported = false, woken = false }) => transaction(state => {
    const row = state.operations.find(item => item.kind === WAKE_KIND && item.id === id);
    if (!row) stale('The harness wake obligation changed.');
    const record = parseWake(row);
    if (reported && record.overlap) record.reported = true;
    if (woken) record.woken = true;
    if (record.woken && (!record.overlap || record.reported)) state.operations = state.operations.filter(item => item.id !== id);
    else {
      const { id: _id, ...details } = record;
      row.resource = JSON.stringify(details);
    }
  });
  const reserve = ({ action, runtime: runtimeId, exclusive = false }) => {
    if (!actions.has(action) || !runtime(runtimeId) || typeof exclusive !== 'boolean') stale('Invalid harness action.');
    return transaction(state => {
      if (state.hold || state.exclusive || inspect(state) || state.operations.some(op => ['deferred-update', WAKE_KIND].includes(op.kind))
        || (exclusive && state.operations.length)) throw error('MAINTENANCE_HELD', 'PortOS work or another update is active.');
      const requestedAt = new Date(now()).toISOString();
      const operation = { id: makeId(), ownerPid: process.pid, requestedAt, phase: 'starting', childPid: null,
        holdId: exclusive ? makeId() : null, holdRevision: exclusive ? state.revision + 1 : null,
        action, runtime: runtimeId };
      if (exclusive) state.hold = { id: operation.holdId, revision: operation.holdRevision,
        reason: 'Updating a harness', owner: 'harness-action', requestedAt };
      save(state, operation);
      return { ...operation };
    });
  };
  // The wrapper MUST enter before launching the vendor command. This closes
  // the crash gap between spawning and recording an updater PID.
  const enter = (id, childPid) => transaction(state => {
    const op = current(state, id);
    if (!pid(childPid) || op.phase !== 'starting' || parentPid() !== op.ownerPid || !ownerPresent(op.ownerPid) || !sameHold(state, op)
      || (op.holdId && (op.invalidated || state.operations.some(row => row.id !== op.id)))) stale('Harness action can no longer start.');
    op.phase = 'entered';
    op.childPid = childPid;
    save(state, op);
    return { ...op };
  });
  const verify = (id, childPid) => transaction(state => {
    const op = current(state, id);
    if (op.phase !== 'entered' || op.childPid !== childPid || parentPid() !== op.ownerPid || !ownerPresent(op.ownerPid) || !sameHold(state, op)
      || (op.holdId && (op.invalidated || state.operations.some(row => row.id !== op.id)))) stale('Harness action can no longer start.');
    // From this point the vendor spawn may occur. Recovery before this point
    // prevents launch; recovery afterwards is a possible overlap to report.
    op.phase = 'running';
    save(state, op);
    return true;
  });
  const observeExistingWork = state => {
    const op = inspect(state);
    if (op?.holdId && !op.invalidated) {
      op.invalidated = true;
      if (op.phase === 'running') op.overlap = true;
      save(state, op);
    }
  };
  // Only the live owner settles its action. A spawned wrapper's complete POSIX
  // group must be absent; an exited wrapper alone does not prove settlement.
  const finish = (id, childPid = null) => transaction(state => {
    const op = current(state, id);
    if (op.ownerPid !== process.pid || (op.childPid && op.childPid !== childPid)
      || (childPid !== null && (!pid(childPid) || !absent(-childPid)))
      || (op.phase !== 'starting' && !childPid)) stale('Harness action processes have not settled.');
    return settle(state, op);
  });
  const reconcile = () => {
    const before = operation();
    if (!before || !absent(before.ownerPid) || (before.childPid && !absent(-before.childPid))) return null;
    // A still-starting wrapper cannot enter once its owner is dead. Recheck the
    // exact row under the transaction in case it entered while we inspected.
    return transaction(state => {
      const live = current(state, before.id);
      if (JSON.stringify(live) !== JSON.stringify(before) || !absent(live.ownerPid)
        || (live.childPid && !absent(-live.childPid))) stale();
      return settle(state, live);
    });
  };
  return { inspect, operation, pendingWake, markWakeProgress, reserve, enter, verify, observeExistingWork, finish, reconcile };
}
