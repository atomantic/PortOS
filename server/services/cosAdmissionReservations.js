/**
 * In-process admission reservations shared by CoS agents and direct autonomous
 * provider turns. They bridge the await window before a durable agent/usage
 * record exists, so every admission path observes the same pending work.
 */

import { remainingActionBudget } from '../lib/domainBudgets.js';

const globalReservations = new Map();
const actionReservations = new Map();
let reservationSequence = 0;

const noopRelease = () => {};

function reserve(map, reservationId) {
  const token = ++reservationSequence;
  map.set(token, reservationId || null);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    map.delete(token);
  };
}

function runningAgentEntries(agents) {
  return Object.values(agents || {}).filter((agent) => agent.status === 'running');
}

export function pendingCosGlobalReservations(agents = {}) {
  const runningTaskIds = new Set(runningAgentEntries(agents).map((agent) => agent.taskId).filter(Boolean));
  let count = 0;
  for (const reservationId of globalReservations.values()) {
    if (!reservationId || !runningTaskIds.has(reservationId)) count += 1;
  }
  return count;
}

export function acquireCosGlobalSlot({ agents = {}, limit, reservationId = null } = {}) {
  const max = Number(limit);
  const running = runningAgentEntries(agents).length;
  const pending = pendingCosGlobalReservations(agents);
  if (Number.isSafeInteger(max) && max > 0 && running + pending >= max) {
    return { ok: false, reason: `CoS agent capacity exhausted (${running + pending}/${max})` };
  }
  return { ok: true, release: reserve(globalReservations, reservationId) };
}

export function pendingCosActionReservations() {
  return actionReservations.size;
}

export function acquireCosActionReservation({ budget, usage, inFlight = 0, reservationId = null } = {}) {
  const pending = pendingCosActionReservations();
  if (remainingActionBudget(budget, usage, inFlight + pending) < 1) {
    return { ok: false, reason: 'CoS actions budget exhausted' };
  }
  return { ok: true, release: reserve(actionReservations, reservationId) };
}

export function __resetCosAdmissionReservations() {
  globalReservations.clear();
  actionReservations.clear();
}
