/**
 * In-flight app update/standardize operations, keyed by app id.
 *
 * These run for minutes and outlive the page that dispatched them, so the
 * server owns both the re-entrancy guard and the resumable progress buffer.
 *
 * Extracted from `sockets/apps.js` because the socket handler is no longer the
 * only caller: `services/appUpdateRunner.js` claims the same resource for an
 * unattended auto-update, and `services/activeProcessing.js` reads the registry
 * so a running app operation counts as system activity (an auto-update must not
 * restart PortOS while App Management is mid-deploy of something else).
 */

import { noteSystemActivity } from './systemActivityNotify.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { settleAdmissionEventually } from '../lib/maintenanceSettlementRetry.js';

const activeAppOperations = new Map();
const admissionByOperation = new WeakMap();

export const appOperationResource = (repoPath, appId) => {
  if (appId) return appId;
  let path = resolve(repoPath);
  try { path = realpathSync(path); } catch { /* The operation will report an invalid path itself. */ }
  return path.length <= 256 ? path : `path-sha256-${createHash('sha256').update(path).digest('hex')}`;
};

const END_PHASES = new Set(['completion', 'failure', 'cancellation']);

/**
 * The live operations as rows — id, name, type, age. One operation occupies
 * several keys, so they collapse back to one row; repoPath stays server-side,
 * since the client only needs to name and render the run.
 */
export const listActiveAppOperations = ({ includeUpdateOwnership = false, onlyRunning = false } = {}) =>
  [...new Set(activeAppOperations.values())].filter(operation => !onlyRunning || admissionByOperation.get(operation)?.running === true).map(operation => {
    const { repoPath: _repoPath, ...op } = operation;
    const supervisorPid = admissionByOperation.get(operation)?.supervisorPid;
    return { ...op, ...(includeUpdateOwnership && supervisorPid ? { deferredUpdateOwnerPid: supervisorPid } : {}) };
  });

/** The same rows in the shape the `app:operations:active` frame carries. */
export const activeOperationsPayload = () => ({ operations: listActiveAppOperations() });

// Two app records may point at the same checkout, so the app id alone doesn't
// identify the resource being mutated — an operation is registered under every
// key that names the resource it is mutating.
const operationKeys = (app) => (app.repoPath && app.repoPath !== app.id ? [app.id, app.repoPath] : [app.id]);

const findConflictingOperation = (app) => operationKeys(app)
  .map(key => activeAppOperations.get(key))
  .find(Boolean);

// Refuse rather than overwrite: a caller that reaches the registry without
// going through claimAppOperation must not be able to silently clobber a live
// run out of the map and orphan its step buffer.
const setOperationKey = (key, operation) => {
  if (activeAppOperations.has(key)) throw new Error(`App operation already in flight for ${key}`);
  activeAppOperations.set(key, operation);
};

/**
 * Claim the resource for this run. The conflict check and the registry write
 * are one synchronous step — an await between them is what let two overlapping
 * dispatches both pass the check, both run, and then delete each other's
 * record (#6638). Callers must claim BEFORE any further await.
 */
export const claimAppOperation = (io, app, type) => {
  const inFlight = findConflictingOperation(app);
  if (inFlight) return { ok: false, inFlight };
  const operation = { appId: app.id, appName: app.name, type, steps: [], startedAt: Date.now(), repoPath: app.repoPath };
  const permit = maintenance.admit('app-operation', String(app.id).slice(0, 256));
  admissionByOperation.set(operation, { permit, supervisorPid: null });
  try {
    for (const key of operationKeys(app)) setOperationKey(key, operation);
    io.emit('app:operations:active', activeOperationsPayload());
    noteSystemActivity('appOperations', 'start');
    return { ok: true, operation };
  } catch (error) {
    for (const [key, op] of activeAppOperations) if (op === operation) activeAppOperations.delete(key);
    void settleAdmissionEventually(permit, 'App operation');
    throw error;
  }
};

// A PortOS self-update deliberately leaves its operation registered: the
// process is about to be replaced, so the map dies with it. A test driving that
// path has no process boundary, so it needs a way back to an empty set.
export const __resetAppOperations = () => {
  for (const op of new Set(activeAppOperations.values())) void settleAdmissionEventually(admissionByOperation.get(op)?.permit, 'App operation');
  activeAppOperations.clear();
};

// A self-update remains visible until this server exits. Its admission covers
// preflight/pull, then the exact detached supervisor takes over ownership.
export async function handOffAppOperation(operation, supervisorPid) {
  const admission = admissionByOperation.get(operation);
  if (!admission || !Number.isSafeInteger(supervisorPid) || supervisorPid <= 0)
    throw new Error('The self-update supervisor identity is unavailable.');
  admission.supervisorPid = supervisorPid;
  const settled = await settleAdmissionEventually(admission.permit, 'App update');
  if (settled) admission.permit = null;
}

export function isSoleDeferredUpdateAppOperation(snapshot, supervisorPid) {
  const active = [...new Set(activeAppOperations.values())];
  if (active.length !== 1 || !Array.isArray(snapshot) || snapshot.length !== 1) return false;
  const op = active[0];
  return admissionByOperation.get(op)?.supervisorPid === supervisorPid
    && snapshot[0].appId === op.appId && snapshot[0].type === op.type && snapshot[0].startedAt === op.startedAt;
}

export const runAppOperation = async (operation, fn) => {
  const admission = admissionByOperation.get(operation);
  admission.running = true;
  try { return await admission.permit.run(fn); }
  finally { admission.running = false; }
};

// Clear every key this operation holds, and only the keys pointing at THIS
// operation — a run that already finished must not evict a live sibling.
export const endAppOperation = (io, appId, phase = 'completion', expected = null) => {
  const operation = activeAppOperations.get(appId);
  if (!operation || (expected && operation !== expected)) return;
  for (const [key, op] of activeAppOperations) {
    if (op === operation) activeAppOperations.delete(key);
  }
  void settleAdmissionEventually(admissionByOperation.get(operation)?.permit, 'App operation');
  io.emit('app:operations:active', activeOperationsPayload());
  const activityPhase = END_PHASES.has(phase) ? phase : 'completion';
  noteSystemActivity('appOperations', activityPhase);
  // Ending the last operation is the queue drain. A second note in the same
  // turn coalesces with the first; the following read sees an empty registry.
  if (listActiveAppOperations().length === 0) noteSystemActivity('appOperations', 'drained');
};

// Record a step into the operation's buffer using the same last-write-wins
// per-step semantics the client renders with.
export const recordOperationStep = (operation, frame) => {
  const existing = operation.steps.findIndex(s => s.step === frame.step);
  if (existing >= 0) operation.steps[existing] = frame;
  else operation.steps.push(frame);
};
