/** Disposition of inactive admission records; it never rewrites work outcomes. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { syncMaintenanceDirectory } from '../lib/maintenanceJournal.js';
import { isOperatorDisposableReservation } from '../lib/maintenanceAdmission.js';
import { currentTaskTypeName } from '../lib/taskTypeRenames.js';
import { SELF_IMPROVEMENT_TASK_TYPES } from '../lib/scheduledTaskTypes.js';
import { isCompletedLocalClaim, mediaRecoveryPending, recordedMediaChildIds } from '../lib/mediaRecoveryActivity.js';
import { findObservedReservationProcesses } from './maintenanceProcessInventory.js';

const operationSchema = z.object({
  id: z.string().uuid(), kind: z.string().min(1), resource: z.string().max(256),
  pid: z.number().int().positive(), startedAt: z.string().datetime(),
  unsettled: z.boolean().optional(), uncertaintyStamp: z.string().uuid().optional(),
}).strict();
const requestFields = {
  version: z.literal(1), requestId: z.string().uuid(),
  operator: z.string().min(1).max(128), reason: z.string().trim().min(8).max(500),
  operations: z.array(operationSchema).min(1).max(500),
};
const requestSchema = z.union([
  z.object({ ...requestFields, hold: z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict() }).strict(),
  z.object({ ...requestFields, update: z.object({ id: z.string().uuid(), ownerPid: z.number().int().positive(), requestedAt: z.string().datetime() }).strict() }).strict(),
]);

const refuse = message => { throw Object.assign(new Error(message), { code: 'MAINTENANCE_STALE' }); };
const MISSING = Symbol('missing evidence');
const MALFORMED = Symbol('malformed evidence');
const dead = pid => {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
};
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const inactiveOwner = (op, isDead, processes, gate) => {
  if (gate.isLocallyFinished?.(op)) return true;
  if (isDead(op.pid)) return true;
  const running = processes.find(proc => proc.pid === op.pid);
  return Number.isFinite(running?.startedAt) && running.startedAt > Date.parse(op.startedAt) + 2000;
};
function assertOrdinaryRunnerRecords(records) {
  if (records.some(record => {
    const metadata = record?.metadata ?? {};
    const types = [metadata.taskAnalysisType, metadata.analysisType, metadata.selfImprovementType].map(currentTaskTypeName);
    return types.some(type => ['do-release', 'release-sync'].includes(type))
      || (typeof record?.taskId === 'string' && (record.taskId.startsWith('task-release-sync-') || record.taskId.includes('-do-release-')))
      || record?.releasePublication || record?.releaseCandidate || record?.releaseCandidateRecovery
      || metadata.releasePublication || metadata.releaseCandidate || metadata.releaseCandidateLifecycle
      || metadata.releaseCandidateSuccessor || metadata.releaseCandidateRecovery
      || metadata.releaseSynchronization || metadata.releaseSynchronizationCheckout || metadata.releaseAttempts;
  })) refuse('Release-agent ownership must use its release recovery path.');
}

// Only positively identified ordinary agents are eligible; ambiguous and
// release-related ownership stays with the existing release/agent workflow.
export function isOrdinaryAgentRecord(operation, record, task = null) {
  if (!record || record.id !== operation.resource || record.status === 'running') return false;
  if (record.taskId && (!task || task.id !== record.taskId)) return false;
  try { assertOrdinaryRunnerRecords([record, task]); } catch { return false; }
  const records = [record, task].filter(Boolean);
  const descriptions = records.map(item => item.description ?? item.metadata?.taskDescription);
  const types = records.flatMap(item => [item.metadata?.taskAnalysisType, item.metadata?.analysisType, item.metadata?.selfImprovementType])
    .map(currentTaskTypeName).filter(Boolean);
  if (/release[-_ ]sync|do[-_: ]release/i.test(operation.resource)
    || descriptions.some(description => typeof description === 'string'
      && /(?:\/do[: -]release|\brelease\b|publish\s+(?:a\s+)?(?:version|tag))/i.test(description))) return false;
  if (types.length) return types.every(type => SELF_IMPROVEMENT_TASK_TYPES.includes(type));
  const userTask = task ?? (!record.taskId ? record : null);
  return userTask?.taskType === 'user' && typeof userTask.description === 'string' && Boolean(userTask.description.trim());
}

// An operator-controlled evidence path must never block the journal on a FIFO
// or follow a substituted link. Missing files are distinct from unreadable ones.
function readEvidence(path, io, maxBytes = 1024 * 1024, includeMtime = false, allowMalformed = false) {
  let fd;
  try {
    fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return MISSING;
    refuse('Recovery evidence could not be read safely.');
  }
  try {
    const before = io.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) refuse('Recovery evidence must be a bounded regular file.');
    const raw = io.readFileSync(fd);
    const after = io.fstatSync(fd);
    const current = io.lstatSync(path);
    if (raw.length !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key =>
      before[key] !== after[key] || after[key] !== current[key]))
      refuse('Recovery evidence changed during inspection.');
    try {
      const value = JSON.parse(raw.toString('utf8'));
      return includeMtime ? { value, mtimeMs: after.mtimeMs } : value;
    }
    catch { if (allowMalformed) return MALFORMED; refuse('Recovery evidence is unreadable.'); }
  } catch (error) {
    if (error.code === 'MAINTENANCE_STALE') throw error;
    refuse('Recovery evidence could not be read safely.');
  } finally { io.closeSync(fd); }
}

function recordedRunnerPids(data, operations, io) {
  const ids = operations.filter(op => op.kind === 'runner').map(op => op.resource);
  if (ids.some(id => !/^agent-[a-z0-9-]+$/i.test(id))) refuse('A runner identity is invalid.');
  if (!ids.length) return [];
  const root = join(data, 'cos', 'agents');
  const runnerState = readEvidence(join(data, 'cos', 'runner-state.json'), io);
  if (runnerState !== MISSING && (!runnerState || !runnerState.agents || typeof runnerState.agents !== 'object' || Array.isArray(runnerState.agents)))
    refuse('The saved runner inventory is unreadable.');
  const pids = [];
  for (const id of ids) {
    const owner = runnerState === MISSING ? null : runnerState.agents[id];
    if (!owner) continue;
    assertOrdinaryRunnerRecords([owner]);
    if (owner.pid == null) continue;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) refuse('A saved runner process identity is invalid.');
    pids.push({ pid: owner.pid, completedAt: owner.completedAt ?? owner.pausedAt ?? null });
  }
  let dates;
  try { dates = io.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)); }
  catch (error) { if (error.code === 'ENOENT') return pids; refuse('Archived runner identities could not be read.'); }
  const paths = ids.map(id => [id, join(root, id, 'metadata.json')]);
  for (const entry of dates) for (const id of ids) paths.push([id, join(root, entry.name, id, 'metadata.json')]);
  for (const [id, path] of paths) {
    const record = readEvidence(path, io);
    if (record === MISSING) continue;
    if (!record || typeof record !== 'object' || Array.isArray(record)) refuse('An archived runner identity is unreadable.');
    if ((record.id ?? record.agentId) !== id) refuse('An archived runner identity changed.');
    assertOrdinaryRunnerRecords([record]);
    if (Number.isSafeInteger(record.pid) && record.pid > 0)
      pids.push({ pid: record.pid, completedAt: record.completedAt ?? record.pausedAt ?? null });
  }
  return pids;
}

function heavyClaim(data, io) {
  const path = join(data, 'heavy-local-job.claim.json');
  const evidence = readEvidence(path, io, 1024 * 1024, true, true);
  if (evidence === MISSING || evidence === MALFORMED || !Number.isSafeInteger(evidence.value?.pid) || evidence.value.pid <= 0) return null;
  const completed = readEvidence(`${path}.completed.json`, io, 1024 * 1024, false, true);
  if (completed !== MISSING && completed !== MALFORMED && isCompletedLocalClaim(evidence.value, completed)) return null;
  return { pid: evidence.value.pid, boundAt: evidence.mtimeMs };
}

function assertSavedMediaIdle(data, io, required) {
  const snapshot = readEvidence(join(data, 'media-jobs.json'), io, 32 * 1024 * 1024);
  if ((snapshot === MISSING && required) || (snapshot !== MISSING && (!snapshot || !Array.isArray(snapshot.jobs) || snapshot.jobs.some(mediaRecoveryPending))))
    refuse('A saved media job still needs recovery or its inventory is unreadable.');
  return snapshot === MISSING ? [] : snapshot.jobs;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    refuse('Activity checks require a loopback HTTP origin.');
  return url.origin;
}

export function assertInactiveActivity(activity, runnerAgents, { waitingUpdate = false } = {}) {
  if (!Array.isArray(activity?.jobs) || activity.jobs.some(job => !job || job.status !== 'queued')
    || activity.agents?.trusted !== true || activity.agents.active !== 0
    || activity.mind?.trusted !== true || activity.mind.thinking !== false
    || activity.llm?.trusted !== true || activity.llm.active !== 0
    || !Array.isArray(activity.extras?.imageTo3d) || activity.extras.imageTo3d.length
    || !Array.isArray(activity.appOperations) || activity.appOperations.length
    || !Array.isArray(activity.renders) || activity.renders.length
    || (waitingUpdate ? typeof activity.update?.inProgress !== 'boolean' : activity.update?.inProgress !== false)
    || activity.backup?.inProgress !== false || !Array.isArray(runnerAgents) || runnerAgents.length)
    refuse('PortOS has running work or its activity could not be verified.');
}

/** Bind the activity read to the held install and fail closed on missing slices. */
export async function inspectLiveActivity({ hold, apiOrigin, runnerOrigin, token, fetcher = fetch }) {
  const api = loopbackOrigin(apiOrigin);
  const runner = loopbackOrigin(runnerOrigin);
  const read = async (url, authenticated) => {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: authenticated && token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) refuse('The local activity service could not be read.');
    return response.json();
  };
  const sameHold = status => status?.hold?.id === hold.id && status.hold.revision === hold.revision;
  if (!sameHold(await read(`${api}/api/system/maintenance`, true))) refuse('The running service does not own this maintenance hold.');
  const activity = await read(`${api}/api/system/processing`, true);
  const runnerAgents = await read(`${runner}/agents`, false);
  assertInactiveActivity(activity, runnerAgents);
  if (!sameHold(await read(`${api}/api/system/maintenance`, true))) refuse('The maintenance hold changed during the activity check.');
}

export async function inspectInactiveReservations({ gate, operator, reason, checkActivity, isDead = dead }) {
  const status = gate.status();
  if (!status.hold || status.state === 'unavailable' || !['Local operator', 'Operator session'].includes(status.hold.owner))
    refuse('Begin a normal operator maintenance hold before inspection.');
  const hold = { id: status.hold.id, revision: status.hold.revision };
  const observed = await checkActivity(hold);
  const processes = Array.isArray(observed?.processes) ? observed.processes : [];
  const current = gate.status();
  if (current.revision !== status.revision) refuse('Work changed during the activity check. Inspect it again.');
  // Runner ownership may carry release authority in the DB-backed agent/task
  // store. The offline operator command cannot classify it from files alone.
  const operations = gate.operations().filter(op => op.kind !== 'runner' && isOperatorDisposableReservation(op)
    && inactiveOwner(op, isDead, processes, gate)).slice(0, 500);
  if (!operations.length) refuse('No supported inactive reservations were found.');
  const request = { version: 1, requestId: randomUUID(), hold, operator, reason: reason.trim(), operations };
  requestSchema.parse(request);
  return request;
}

/** Publish a durable receipt before retiring exactly the inspected records. */
export async function disposeInactiveReservations(input, { gate, operator, checkActivity, isDead = dead, isAlive = alive, isEnabled = () => true, io = fs, requireMediaInventory = false }) {
  requestSchema.parse(input);
  // Preserve the inspected records exactly; the transaction checks every field.
  const request = input;
  const automatic = Boolean(request.update);
  const disposition = automatic ? 'automatically-abandoned' : 'operator-disposed';
  if (request.operator !== operator) refuse('The request belongs to a different local operator.');
  const before = gate.status();
  if (automatic) {
    if (before.hold || before.deferredUpdate?.id !== request.update.id || before.deferredUpdate.phase !== 'waiting')
      refuse('The waiting update changed.');
  } else if (before.hold?.id !== request.hold.id || before.hold.revision !== request.hold.revision)
    refuse('The maintenance hold changed. Inspect again.');
  const data = dirname(gate.directory);
  const observed = await checkActivity(automatic ? request.update : request.hold, request.operations) ?? [];
  const checkedPids = Array.isArray(observed) ? observed : observed.pids;
  const processes = Array.isArray(observed?.processes) ? observed.processes : [];
  const ordinaryOwnerIds = Array.isArray(observed?.ordinaryOwnerIds) ? observed.ordinaryOwnerIds : [];
  const limitations = Array.isArray(observed?.limitations) ? observed.limitations.filter(item => typeof item === 'string') : [];
  if (request.operations.some(op => ['agent', 'runner'].includes(op.kind) && automatic && !ordinaryOwnerIds.includes(op.id))
    || request.operations.some(op => ['agent', 'runner'].includes(op.kind) && !automatic))
    refuse('An agent owner needs its own recovery path.');
  if (!Array.isArray(checkedPids) || checkedPids.some(item => {
    const pid = typeof item === 'number' ? item : item?.pid;
    return !Number.isSafeInteger(pid) || pid <= 0;
  }))
    refuse('Known process identities could not be checked.');
  const knownPids = [...checkedPids, ...recordedRunnerPids(data, request.operations, io)];
  const activeKnownProcess = identity => {
    const pid = typeof identity === 'number' ? identity : identity.pid;
    if (isDead(pid)) return false;
    const running = processes.find(proc => proc.pid === pid);
    if (String(running?.state ?? '').startsWith('Z')) return false;
    const completedAt = typeof identity === 'number' ? NaN : Number.isFinite(identity.boundAt) ? identity.boundAt : Date.parse(identity.completedAt);
    return !(Number.isFinite(completedAt) && Number.isFinite(running?.startedAt) && running.startedAt > completedAt + 2000);
  };
  const after = gate.status();
  if (after.revision !== before.revision) refuse('Work changed during the activity check. Inspect it again.');
  const receiptPath = join(gate.directory, `reservation-disposition-${request.requestId}.json`);
  const readReceipt = () => {
    let fd;
    try {
      fd = io.openSync(receiptPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const stat = io.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) refuse('The existing disposition receipt is invalid.');
      let receipt;
      try { receipt = JSON.parse(io.readFileSync(fd, 'utf8')); }
      catch { refuse('The existing disposition receipt is invalid.'); }
      if (receipt.version !== 1 || receipt.disposition !== disposition
        || receipt.outputCompleteness !== 'unknown' || !isDeepStrictEqual(receipt.request, request))
        refuse('The existing disposition receipt does not match this request.');
      io.fsyncSync(fd);
      syncMaintenanceDirectory(gate.directory, io);
      return receipt;
    } finally { if (fd !== undefined) io.closeSync(fd); }
  };
  const publish = () => {
    try { return readReceipt(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const receipt = { version: 1, disposition, outputCompleteness: 'unknown',
      ...(limitations.length ? { processInspectionLimitations: limitations } : {}), at: new Date().toISOString(), request };
    const pending = `${receiptPath}.${randomUUID()}.pending`;
    const fd = io.openSync(pending, 'wx', 0o600);
    try { io.writeFileSync(fd, JSON.stringify(receipt) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
    io.linkSync(pending, receiptPath);
    syncMaintenanceDirectory(gate.directory, io);
    io.unlinkSync(pending);
    syncMaintenanceDirectory(gate.directory, io);
    return receipt;
  };
  return gate.reconcileInactiveReservations({ hold: request.hold, update: request.update, revision: after.revision, expected: request.operations, ordinaryAgentIds: ordinaryOwnerIds,
    validate: operations => {
      const accelerator = heavyClaim(data, io);
      const jobs = assertSavedMediaIdle(data, io, requireMediaInventory && request.operations.some(op => ['media', 'music-video'].includes(op.kind)));
      const segments = recordedMediaChildIds(jobs).map(resource => ({ kind: 'media', resource }));
      if (findObservedReservationProcesses(processes, segments, dirname(data)).length)
        refuse('A local media segment is still running.');
      if (!isEnabled() || (automatic && !isAlive(request.update.ownerPid)) || knownPids.some(activeKnownProcess)
        || (accelerator && activeKnownProcess(accelerator))
        || operations.some(op => op.id !== request.update?.id && !inactiveOwner(op, isDead, processes, gate)))
        refuse('A recorded owner process is still running or cannot be checked.');
    }, publish, replay: () => {
      try { return { ...readReceipt(), replayed: true }; }
      catch (error) {
        if (error.code === 'ENOENT') refuse('The reservations changed and no matching disposition receipt exists.');
        throw error;
      }
    } });
}

/** Reconcile only while this exact supervisor is waiting to acquire admission. */
export async function reconcileWaitingUpdate({ gate, checkActivity, isDead = dead, isAlive = alive, isEnabled = () => true }) {
  const status = gate.status();
  const owner = status.deferredUpdate;
  if (status.hold || !owner || owner.phase !== 'waiting' || owner.childPid || owner.holdId) return null;
  let operations = gate.operations().filter(op => (isOperatorDisposableReservation(op) || op.kind === 'agent')
    && (op.kind !== 'runner' || /^agent-[a-z0-9-]+$/i.test(op.resource))).slice(0, 500);
  if (!operations.length) { await checkActivity(owner, []); return null; }
  if (operations.some(op => ['agent', 'runner'].includes(op.kind))) {
    const initial = await checkActivity(owner, operations);
    const ordinary = new Set(Array.isArray(initial?.ordinaryOwnerIds) ? initial.ordinaryOwnerIds : []);
    operations = operations.filter(op => !['agent', 'runner'].includes(op.kind) || ordinary.has(op.id));
    if (!operations.length) return null;
  }
  const operator = 'PortOS automatic recovery';
  const request = { version: 1, requestId: randomUUID(), operator, reason: 'Inactive admission during deferred update',
    update: { id: owner.id, ownerPid: owner.ownerPid, requestedAt: owner.requestedAt }, operations };
  return disposeInactiveReservations(request, { gate, operator, checkActivity, isDead, isAlive, isEnabled });
}
