/** Reconcile inspected maintenance reservations against the locked journal snapshot. */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { maintenanceError as error } from '../maintenanceJournal.js';

export const isOperatorDisposableReservation = op => ['media', 'runner', 'api-run', 'cli-run', 'tui-run', 'manual-run', 'heavy-job',
  'script-job', 'shell-job', 'provider', 'music-video', 'app-operation', 'backup'].includes(op.kind)
  || (op.kind === 'settlement' && op.resource === 'Output publication');

function sameReservation(seen, op) {
  return seen.id === op.id && seen.kind === op.kind && seen.resource === op.resource
    && seen.pid === op.pid && seen.startedAt === op.startedAt;
}

// Removes only settled records still identical to what the caller inspected;
// anything that changed (or settled elsewhere) since then is left alone.
export function releaseObservedOperations(state, expected) {
  const before = state.operations.length;
  state.operations = state.operations.filter(op => op.unsettled
    || !expected.some(seen => sameReservation(seen, op)));
  return before - state.operations.length;
}

// Fail-closed stamp for records the caller already inspected. Already-unsettled
// rows keep their stamp: rotating it would invalidate an operator receipt in flight.
export function markObservedOperationsUncertain(state, expected) {
  let marked = 0;
  for (const op of state.operations) {
    if (op.unsettled) continue;
    const seen = expected.some(seen => sameReservation(seen, op));
    if (!seen) continue;
    op.unsettled = true;
    op.uncertaintyStamp = randomUUID();
    marked += 1;
  }
  return marked;
}

// Publish the receipt before removing any inspected reservations from the journal.
export function reconcileReservations(state, { hold, update, revision, expected, ordinaryAgentIds = [], validate, publish, replay }, inspectUpdate) {
  if (update) {
    const owner = inspectUpdate(state);
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
}
