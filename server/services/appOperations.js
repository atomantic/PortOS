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

const activeAppOperations = new Map();

// One operation occupies several keys, so collapse them back to one row.
// repoPath stays server-side: the client only needs to name and render the run.
export const activeOperationsPayload = () => ({
  operations: [...new Set(activeAppOperations.values())].map(({ repoPath: _repoPath, ...op }) => op)
});

/**
 * The live operations as activity rows — id, name, type, age. Same projection
 * as the socket payload; named separately so the activity snapshot does not
 * read as if it were about to emit a socket frame.
 */
export const listActiveAppOperations = () => activeOperationsPayload().operations;

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
  for (const key of operationKeys(app)) setOperationKey(key, operation);
  io.emit('app:operations:active', activeOperationsPayload());
  return { ok: true, operation };
};

// A PortOS self-update deliberately leaves its operation registered: the
// process is about to be replaced, so the map dies with it. A test driving that
// path has no process boundary, so it needs a way back to an empty set.
export const __resetAppOperations = () => activeAppOperations.clear();

// Clear every key this operation holds, and only the keys pointing at THIS
// operation — a run that already finished must not evict a live sibling.
export const endAppOperation = (io, appId) => {
  const operation = activeAppOperations.get(appId);
  if (!operation) return;
  for (const [key, op] of activeAppOperations) {
    if (op === operation) activeAppOperations.delete(key);
  }
  io.emit('app:operations:active', activeOperationsPayload());
};

// Record a step into the operation's buffer using the same last-write-wins
// per-step semantics the client renders with.
export const recordOperationStep = (operation, frame) => {
  const existing = operation.steps.findIndex(s => s.step === frame.step);
  if (existing >= 0) operation.steps[existing] = frame;
  else operation.steps.push(frame);
};
