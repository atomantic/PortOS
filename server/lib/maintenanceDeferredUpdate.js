import { join } from 'node:path';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const pid = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const parseOperation = value => {
  if (!record(value) || Object.keys(value).some(key => !['id', 'ownerPid', 'phase', 'childPid', 'holdId', 'requestedAt', 'terminal'].includes(key))
    || !uuid(value.id) || !pid(value.ownerPid) || !['waiting', 'starting', 'running'].includes(value.phase)
    || (value.childPid !== null && !pid(value.childPid)) || (value.holdId !== null && !uuid(value.holdId)) || !date(value.requestedAt)
    || (value.terminal !== undefined && (!record(value.terminal) || Object.keys(value.terminal).length !== 1 || typeof value.terminal.success !== 'boolean'))) {
    throw new Error('Invalid deferred update owner');
  }
  return value;
};
const parseResult = value => {
  if (!record(value) || Object.keys(value).length !== 4 || !uuid(value.id)
    || typeof value.success !== 'boolean' || typeof value.interrupted !== 'boolean' || !date(value.completedAt)) {
    throw new Error('Invalid deferred update result');
  }
  return value;
};

// Only ESRCH proves absence. Permission failures, reused PIDs and unavailable
// process-group probes must never reopen work while an update may still run.
export function processAbsent(pid, kill = process.kill) {
  try { kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
}

// A pre-claim ticket cannot authorize mutation after it is removed. Compare the
// exact ticket under the journal lock so a supervisor that claimed it wins the
// race even if the original launcher's PID was subsequently reused.
export async function reconcileReusedLaunch(admission, snapshot) {
  const pending = admission.deferredUpdate.launch();
  if (!pending) return;
  let processes;
  try { processes = await snapshot(); } catch { return; }
  if (!Array.isArray(processes)) return;
  const process = processes.find(row => row.pid === pending.pid);
  if (Number.isFinite(process?.startedAt) && process.startedAt > Date.parse(pending.startedAt) + 2000)
    admission.deferredUpdate.reconcile({ obsoleteLaunch: pending });
}

/** Local updates share the exact transaction that admits agents and renders. */
export function createDeferredUpdateAdmission({ transaction, read, makeId, error, now, directory, io, syncDirectory, lockExists = () => false }) {
  const kind = 'deferred-update';
  const resultPath = join(directory, 'update-result.json');
  const inspect = state => {
    const rows = state.operations.filter(op => op.kind === kind);
    if (rows.length > 1) throw error('MAINTENANCE_UNAVAILABLE', 'Multiple deferred update owners need recovery.');
    const row = rows[0];
    return row ? parseOperation({ ...JSON.parse(row.resource), id: row.id, ownerPid: row.pid, requestedAt: row.startedAt }) : null;
  };
  const save = (state, operation) => {
    const { id, ownerPid, requestedAt, ...details } = operation;
    const row = { id, kind, pid: ownerPid, startedAt: requestedAt, resource: JSON.stringify(details) };
    const index = state.operations.findIndex(op => op.id === id);
    if (index < 0) state.operations.push(row);
    else state.operations[index] = row;
  };
  const readResult = () => {
    try { return parseResult(JSON.parse(io.readFileSync(resultPath, 'utf8'))); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };
  const writeResult = result => {
    const pending = join(directory, `update-result-${makeId()}.json`);
    const fd = io.openSync(pending, 'wx', 0o600);
    try { io.writeFileSync(fd, JSON.stringify(result) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
    io.renameSync(pending, resultPath);
    syncDirectory(directory, io);
  };
  const stale = () => { throw error('MAINTENANCE_STALE', 'The deferred update ownership changed.'); };
  const current = (state, id) => { const operation = inspect(state); return operation?.id === id ? operation : stale(); };
  const settle = (state, operation, success, interrupted) => {
    if (operation.holdId && state.hold?.id !== operation.holdId) stale();
    const result = { id: operation.id, success, interrupted, completedAt: new Date(now()).toISOString() };
    writeResult(result);
    if (operation.holdId) state.hold = null;
    state.operations = state.operations.filter(op => op.id !== operation.id);
    return result;
  };
  const operation = () => inspect(read());
  const launch = () => read().operations.find(op => op.kind === 'deferred-update-launch') ?? null;
  const get = () => ({ operation: operation(), result: readResult() });
  const reconcile = ({ absent = processAbsent, platform = process.platform, obsoleteLaunch = null } = {}) => {
    const pending = launch();
    const pendingChild = pending?.resource ? JSON.parse(pending.resource).childPid : null;
    if (pendingChild !== null && !pid(pendingChild)) throw error('MAINTENANCE_UNAVAILABLE', 'Invalid deferred update launch identity.');
    if (pending && (absent(pending.pid) || (pendingChild && absent(pendingChild))
      || (obsoleteLaunch && JSON.stringify(pending) === JSON.stringify(obsoleteLaunch)))) transaction(state => {
      const index = state.operations.findIndex(op => op.id === pending.id && op.kind === 'deferred-update-launch');
      if (index >= 0 && JSON.stringify(state.operations[index]) === JSON.stringify(pending)) state.operations.splice(index, 1);
    });
    const { operation } = get();
    if (!operation || !absent(operation.ownerPid)) return get();
    // Before enter(), a child is forbidden from mutating the installation.
    // After enter(), the whole group must be gone, including orphaned npm/git.
    if (operation.childPid && (platform === 'win32'
      ? !operation.terminal || !absent(operation.childPid) : !absent(-operation.childPid))) return get();
    transaction(state => {
      const live = current(state, operation.id);
      if (JSON.stringify(live) !== JSON.stringify(operation)) stale();
      settle(state, live, live.terminal?.success === true, !live.terminal);
    });
    return get();
  };
  const request = () => transaction(state => {
    if (inspect(state) || state.operations.some(op => op.kind === 'deferred-update-launch')) stale();
    if (state.operations.some(op => ['harness-action', 'harness-action-wake'].includes(op.kind)))
      throw error('MAINTENANCE_HELD', 'A harness action is still running or finishing.');
    const operation = { id: makeId(), ownerPid: process.pid, phase: 'waiting', childPid: null, holdId: null, requestedAt: new Date(now()).toISOString() };
    save(state, operation);
    return { ...operation };
  });
  // A launch ticket allows a timed-out parent to cancel a late supervisor
  // before it mutates the install. Claim and cancellation share the journal.
  const reserveLaunch = () => {
    reconcile();
    return transaction(state => {
      if (state.hold || state.exclusive || inspect(state)
        || state.operations.some(op => ['deferred-update-launch', 'harness-action', 'harness-action-wake'].includes(op.kind))) stale();
      const ticket = { id: makeId(), kind: 'deferred-update-launch', resource: '', pid: process.pid,
        startedAt: new Date(now()).toISOString() };
      state.operations.push(ticket);
      return ticket.id;
    });
  };
  const claimLaunch = id => transaction(state => {
    const index = state.operations.findIndex(op => op.id === id && op.kind === 'deferred-update-launch');
    if (index < 0 || inspect(state)) stale();
    const [ticket] = state.operations.splice(index, 1);
    const claimed = { id, ownerPid: process.pid, phase: 'waiting', childPid: null, holdId: null, requestedAt: ticket.startedAt };
    save(state, claimed);
    return { ...claimed };
  });
  const bindLaunch = (id, childPid) => transaction(state => {
    if (!pid(childPid)) throw error('MAINTENANCE_STALE', 'Invalid update supervisor identity.');
    const pending = state.operations.find(op => op.id === id && op.kind === 'deferred-update-launch' && op.pid === process.pid);
    if (!pending) return false;
    pending.resource = JSON.stringify({ childPid });
    return true;
  });
  const cancelLaunch = id => transaction(state => {
    const index = state.operations.findIndex(op => op.id === id && op.kind === 'deferred-update-launch' && op.pid === process.pid);
    if (index >= 0) { state.operations.splice(index, 1); return { state: 'canceled' }; }
    const claimed = inspect(state);
    if (claimed?.id === id) return { state: 'claimed', ownerPid: claimed.ownerPid };
    const result = readResult();
    if (result?.id === id) return { state: 'finished', result };
    return { state: 'unknown' };
  });
  const acquire = (id, { externalWorkPending = false, checkExternal = () => false } = {}) => {
    // A blocked poll need not rewrite the journal every second. The transaction
    // below still rechecks everything when this read sees an idle candidate.
    const observed = read();
    const pending = current(observed, id);
    if (pending.phase !== 'waiting' || pending.ownerPid !== process.pid) stale();
    if (observed.hold) throw error('MAINTENANCE_HELD', 'Another maintenance request superseded the waiting update.');
    if ((externalWorkPending || observed.operations.some(op => op.id !== id) || observed.exclusive) && !lockExists()) return false;
    return transaction(state => {
      const operation = current(state, id);
      if (operation.phase !== 'waiting' || operation.ownerPid !== process.pid) stale();
      if (state.hold) throw error('MAINTENANCE_HELD', 'Another maintenance request superseded the waiting update.');
      if (externalWorkPending || state.operations.some(op => op.id !== id) || state.exclusive || checkExternal()) return false;
      operation.phase = 'starting';
      operation.holdId = makeId();
      state.hold = { id: operation.holdId, revision: state.revision + 1, reason: 'Applying a deferred PortOS update', owner: 'deferred-update', requestedAt: new Date(now()).toISOString() };
      save(state, operation);
      return true;
    });
  };
  const enter = (id, childPid) => transaction(state => {
    const operation = current(state, id);
    if (operation.phase !== 'starting' || processAbsent(operation.ownerPid)
      || state.hold?.id !== operation.holdId || state.operations.some(op => op.id !== id)) stale();
    operation.phase = 'running';
    operation.childPid = childPid;
    save(state, operation);
  });
  const terminal = (id, childPid, success) => transaction(state => {
    const operation = current(state, id);
    if (operation.phase !== 'running' || operation.childPid !== childPid || operation.terminal) stale();
    operation.terminal = { success };
    save(state, operation);
  });
  // Only the owning supervisor calls this after its child closes and its
  // process group drains. A crashed supervisor uses reconcile(), never age.
  const finish = (id, success) => transaction(state => {
    const operation = current(state, id);
    if (operation.ownerPid !== process.pid) stale();
    return settle(state, operation, success, false);
  });
  return { inspect, operation, launch, get, reconcile, request, reserveLaunch, claimLaunch, bindLaunch, cancelLaunch, acquire, enter, terminal, finish };
}
