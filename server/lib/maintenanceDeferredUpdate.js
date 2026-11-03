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
  // Retrying an update may have newer recovery code than the live supervisor.
  // Its waiting fence is transferable; acquire() changes phase under this same
  // lock before a child can start. A starting/running owner is never replaced.
  const replaceWaiting = (state, nextId) => {
    const previous = inspect(state);
    if (!previous) return null;
    if (previous.phase !== 'waiting' || previous.childPid || previous.holdId || state.hold || state.exclusive) stale();
    const receipt = join(directory, `update-handoff-${nextId}.json`);
    const fd = io.openSync(receipt, 'wx', 0o600);
    try { io.writeFileSync(fd, JSON.stringify({ version: 1, previous, successorId: nextId,
      disposition: 'waiting-update-replaced', at: new Date(now()).toISOString() }) + '\n'); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    syncDirectory(directory, io);
    settle(state, previous, false, true);
    return previous.requestedAt;
  };
  const operation = () => inspect(read());
  const launch = () => read().operations.find(op => op.kind === 'deferred-update-launch') ?? null;
  const get = () => ({ operation: operation(), result: readResult() });
  const reconcile = ({ absent = processAbsent, platform = process.platform, obsoleteLaunch = null } = {}) => {
    const pending = launch();
    const pendingChild = pending?.resource ? JSON.parse(pending.resource).childPid ?? null : null;
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
  const request = ({ recoverWaiting = false } = {}) => transaction(state => {
    if ((!recoverWaiting && inspect(state)) || state.operations.some(op => op.kind === 'deferred-update-launch')) stale();
    if (state.operations.some(op => ['harness-action', 'harness-action-wake'].includes(op.kind)))
      throw error('MAINTENANCE_HELD', 'A harness action is still running or finishing.');
    const id = makeId();
    const requestedAt = recoverWaiting ? replaceWaiting(state, id) : null;
    const operation = { id, ownerPid: process.pid, phase: 'waiting', childPid: null, holdId: null, requestedAt: requestedAt ?? new Date(now()).toISOString() };
    save(state, operation);
    return { ...operation };
  });
  // A launch ticket allows a timed-out parent to cancel a late supervisor
  // before it mutates the install. Claim and cancellation share the journal.
  const reserveLaunch = ({ recoverWaiting = false } = {}) => {
    reconcile();
    return transaction(state => {
      if (state.hold || state.exclusive || (!recoverWaiting && inspect(state))
        || state.operations.some(op => ['deferred-update-launch', 'harness-action', 'harness-action-wake'].includes(op.kind))) stale();
      const id = makeId();
      const requestedAt = recoverWaiting ? replaceWaiting(state, id) : null;
      const ticket = { id, kind: 'deferred-update-launch', resource: requestedAt ? JSON.stringify({ requestedAt }) : '', pid: process.pid,
        startedAt: new Date(now()).toISOString() };
      state.operations.push(ticket);
      return ticket.id;
    });
  };
  const claimLaunch = id => transaction(state => {
    const index = state.operations.findIndex(op => op.id === id && op.kind === 'deferred-update-launch');
    if (index < 0 || inspect(state)) stale();
    const [ticket] = state.operations.splice(index, 1);
    const requestedAt = ticket.resource ? JSON.parse(ticket.resource).requestedAt : null;
    if (requestedAt != null && !date(requestedAt)) stale();
    const claimed = { id, ownerPid: process.pid, phase: 'waiting', childPid: null, holdId: null, requestedAt: requestedAt ?? ticket.startedAt };
    save(state, claimed);
    return { ...claimed };
  });
  const bindLaunch = (id, childPid) => transaction(state => {
    if (!pid(childPid)) throw error('MAINTENANCE_STALE', 'Invalid update supervisor identity.');
    const pending = state.operations.find(op => op.id === id && op.kind === 'deferred-update-launch' && op.pid === process.pid);
    if (!pending) return false;
    pending.resource = JSON.stringify({ ...(pending.resource ? JSON.parse(pending.resource) : {}), childPid });
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
  const acquire = (id, { externalWorkPending = false, checkExternal = () => false, interrupt = false } = {}) => {
    // A blocked poll need not rewrite the journal every second. The transaction
    // below still rechecks everything when this read sees an idle candidate.
    const observed = read();
    const pending = current(observed, id);
    if (pending.phase !== 'waiting' || pending.ownerPid !== process.pid) stale();
    if (observed.hold) throw error('MAINTENANCE_HELD', 'Another maintenance request superseded the waiting update.');
    const restorePending = state => state.operations.some(op => op.kind === 'backup' && /^restore(?:-db|-recovery)?:/.test(op.resource));
    if (interrupt && restorePending(observed)) throw error('MAINTENANCE_HELD', 'A database restore is active; finish or recover it before updating.');
    if ((externalWorkPending || (!interrupt && observed.operations.some(op => op.id !== id)) || observed.exclusive) && !lockExists()) return false;
    return transaction(state => {
      const operation = current(state, id);
      if (operation.phase !== 'waiting' || operation.ownerPid !== process.pid) stale();
      if (state.hold) throw error('MAINTENANCE_HELD', 'Another maintenance request superseded the waiting update.');
      if (interrupt && restorePending(state)) throw error('MAINTENANCE_HELD', 'A database restore is active; finish or recover it before updating.');
      if (externalWorkPending || (!interrupt && state.operations.some(op => op.id !== id)) || state.exclusive || checkExternal()) return false;
      operation.phase = 'starting';
      operation.holdId = makeId();
      state.hold = { id: operation.holdId, revision: state.revision + 1, reason: interrupt ? 'Manual update: interrupting work and restarting PortOS' : 'Applying a deferred PortOS update', owner: interrupt ? 'manual-update' : 'deferred-update', requestedAt: new Date(now()).toISOString() };
      save(state, operation);
      return true;
    });
  };
  const enter = (id, childPid) => transaction(state => {
    const operation = current(state, id);
    if (operation.phase !== 'starting' || processAbsent(operation.ownerPid)
      || state.hold?.id !== operation.holdId || (state.hold.owner !== 'manual-update' && state.operations.some(op => op.id !== id))) stale();
    operation.phase = 'running';
    operation.childPid = childPid;
    save(state, operation);
  });
  // Called only after the script has stopped the owning runtimes. This is an
  // interruption receipt, never evidence that a previous output succeeded.
  const settleInterrupted = (id, { preserveIds = [] } = {}) => transaction(state => {
    const operation = current(state, id);
    if (operation.phase !== 'running' || state.hold?.id !== operation.holdId || state.hold.owner !== 'manual-update' || state.exclusive) stale();
    const retained = new Set([id, ...preserveIds]);
    const operations = state.operations.filter(op => !retained.has(op.id));
    if (!operations.length) return;
    const path = join(directory, `update-interrupted-${id}-${makeId()}.json`);
    const fd = io.openSync(path, 'wx', 0o600);
    try { io.writeFileSync(fd, JSON.stringify({ version: 1, updateId: id, at: new Date(now()).toISOString(),
      disposition: 'interrupted', outputCompleteness: 'unknown', operations }) + '\n'); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    syncDirectory(directory, io);
    state.operations = state.operations.filter(op => retained.has(op.id));
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
  return { inspect, operation, launch, get, reconcile, request, reserveLaunch, claimLaunch, bindLaunch, cancelLaunch, acquire, enter, settleInterrupted, terminal, finish };
}
