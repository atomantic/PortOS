/**
 * Exactly-once accounting for a burn whose acceptance is ASYNCHRONOUS.
 *
 * A reference burn no longer queues its own task: it asks the schedule to run a
 * task the user already owns (`quotaBurnInvoke.js` →
 * `taskSchedule.triggerOnDemandTask`). The request lands on the schedule now and
 * one of the two on-demand engines (`cos.js#spawnDequeuePriority0OnDemand`,
 * `cosTaskGenerator.js#spawnPriority0OnDemand`) generates the task later — or
 * refuses it: improvement switched off, the task type disabled since queuing, an
 * app that has gone away, a generator that produced nothing, an identical twin
 * already queued. So "we recorded a request" is NOT "work started", and charging
 * the window cap and the `runOnce` ledger at the request is the same
 * undercount-then-overspend bug #3179 fixed in the dispatch ledger.
 *
 * The fix is a RESERVATION, settled against the outcome:
 *
 *   1. `reserveQuotaBurnDispatch` — the request goes out and the step's place is
 *      held in `data/cos/quota-burn-pending.json`. Nothing is charged yet, but
 *      the reservation counts against `maxDispatchesPerWindow` exactly like a
 *      charge would (`pendingDispatchCounts` in `quotaBurn.js`), so the cap is
 *      honest for the whole in-flight window, and it blocks a second cycle from
 *      queuing the same step.
 *   2. `reconcileQuotaBurnReservations` — every cycle, each reservation whose
 *      request has left the queue is JOINED to the task the engine produced, by
 *      the `quotaBurnRequestId` the request stamps onto it
 *      (`lib/quotaBurnOrigin.js`). A task means accepted: charge once, mark a
 *      `runOnce` step spent, and settle the run-log row with the task id. No
 *      task means refused: release the reservation, charge nothing.
 *
 * The join is what makes this survive a restart — the reservation, the request
 * and the task are all on disk, so a reconcile after a crash reaches the same
 * verdict a reconcile a second later would have. It is also why an ordinary
 * clock-driven run of the very same scheduled task changes nothing here: it
 * carries no burn provenance, so no reservation ever names it.
 *
 * Everything fails CLOSED. An unreadable reservation file, an unreadable
 * schedule, or an unreadable task queue all DEFER — releasing a reservation we
 * cannot judge would either re-open the cap for work that is running or spend a
 * charge on work that never started.
 *
 * The synchronous lanes do not come through here at all: a programmatic handler
 * runs inline and a custom job is queued by `addTask` in the same call, so both
 * are accepted the moment they return and the runner charges them directly.
 */

import { quotaBurnProvenance } from '../lib/quotaBurnOrigin.js';
import { recordQuotaBurnDispatch } from './quotaBurn.js';
import { recordQuotaBurnJobCompletion } from './quotaBurnCompletions.js';
import {
  getQuotaBurnReservations,
  markQuotaBurnReservationCharged,
  quotaBurnReservationKey,
  releaseQuotaBurnStep,
  reserveQuotaBurnStep,
  settleQuotaBurnRun,
} from './quotaBurnStore.js';

/**
 * Hold a step's place while its on-demand request waits to be accepted.
 *
 * `charge` and `runOnce` are captured HERE, from the candidate and the step the
 * cycle actually picked, rather than re-derived at settlement: the plan can be
 * edited (or the family forced) between the request and the drain, and a burn
 * must settle on the terms it was dispatched under. Returns false when the
 * reservation could not be taken — an unreadable file, or a step already
 * reserved — which the caller reports rather than treating as a silent success.
 */
export async function reserveQuotaBurnDispatch({ familyId, stepId, dispatchKey, charge, runOnce, requestId }, { now = Date.now() } = {}) {
  if (!familyId || !stepId || !requestId) return false;
  const written = await reserveQuotaBurnStep({
    familyId, stepId, dispatchKey: dispatchKey || null, charge: Boolean(charge), runOnce: Boolean(runOnce), requestId,
  }, { now });
  return Boolean(written);
}

/** The request ids still waiting on the schedule, or null when it can't be read. */
async function queuedRequestIds() {
  const { getOnDemandRequests } = await import('./taskSchedule.js');
  return getOnDemandRequests()
    .then((requests) => new Set((requests || []).map((request) => request?.id).filter(Boolean)))
    .catch((err) => {
      console.error(`❌ Quota-burn could not read the on-demand request queue: ${err.message}`);
      return null;
    });
}

/**
 * Every task carrying burn provenance, keyed by the request that produced it.
 *
 * Read through `quotaBurnProvenance` rather than `metadata.quotaBurnRequestId`
 * directly: a task round-trips through COS-TASKS.md, which hands every scalar
 * back as a string, and that reader is the one place that coercion lives.
 */
async function burnTasksByRequestId() {
  const { getAllTasks } = await import('./cosTaskStore.js');
  return getAllTasks()
    .then(({ user, cos }) => {
      const byRequest = new Map();
      for (const task of [...(cos?.tasks || []), ...(user?.tasks || [])]) {
        const { requestId } = quotaBurnProvenance(task?.metadata);
        if (requestId && !byRequest.has(requestId)) byRequest.set(requestId, task);
      }
      return byRequest;
    })
    .catch((err) => {
      console.error(`❌ Quota-burn could not read the task queue to settle its reservations: ${err.message}`);
      return null;
    });
}

/**
 * Charge one accepted burn, then let its reservation go.
 *
 * The claim/charge/release order is what keeps this exactly-once across a crash
 * — see `markQuotaBurnReservationCharged`. A ledger that cannot be written keeps
 * the reservation (and un-claims the charge), so the next cycle retries instead
 * of releasing a burn the window was never debited for. The `runOnce` write is
 * idempotent on its key, so a retry re-stamps rather than double-counting.
 */
async function settleAccepted(key, record, task, now) {
  if (record.charge && !record.chargedAt) {
    await markQuotaBurnReservationCharged(key, now, { now });
    const ledger = await recordQuotaBurnDispatch(record.dispatchKey, { now });
    if (!ledger) {
      await markQuotaBurnReservationCharged(key, null, { now });
      console.error(`⚠️ Quota-burn could not charge ${record.familyId}/${record.stepId} — retrying next cycle`);
      return false;
    }
  }
  if (record.runOnce) {
    await recordQuotaBurnJobCompletion(record.familyId, record.stepId, { now })
      // A ledger failure must not fail an acceptance that already happened — the
      // worst case is the step running one extra time, the pre-`runOnce` behavior.
      .catch((err) => console.error(`⚠️ Quota-burn run-once ledger for ${record.familyId}/${record.stepId}: ${err.message}`));
  }
  await settleQuotaBurnRun(record.requestId, {
    pending: false, accepted: true, taskId: task.id, charged: Boolean(record.charge),
  });
  await releaseQuotaBurnStep(key, { now });
  console.log(`🔥 Quota-burn ${record.familyId}/${record.stepId} accepted as task ${task.id}`);
  return true;
}

/**
 * Let a refused burn's reservation go, charging nothing.
 *
 * The row keeps `dispatched: true` — the burn WAS dispatched, and that flag is
 * also the rotation cursor `lastDispatchedJobByFamily` reads. Clearing it would
 * rewind the walk onto the step that just failed and re-request it every cycle,
 * which is the perpetual loop this whole change is meant to rule out. The
 * `summary` carries the outcome instead, so the page's "Recent runs" line stops
 * claiming work that never started.
 */
async function settleRefused(key, record, reason, now) {
  await settleQuotaBurnRun(record.requestId, {
    pending: false, accepted: false, settledReason: reason, summary: `Requested, but not accepted — ${reason}`,
  });
  await releaseQuotaBurnStep(key, { now });
  console.log(`💤 Quota-burn ${record.familyId}/${record.stepId} was not accepted — ${reason}`);
}

/**
 * Settle every reservation whose request has left the queue. Returns a summary
 * for the caller's log, or a `deferred` verdict when a read it depends on failed.
 *
 * Deliberately called only from the CYCLE, never from the status page: this
 * writes ledgers, and a probe read that charged quota would make opening the
 * page a spend (AGENTS.md — a status read performs no ledger write).
 */
export async function reconcileQuotaBurnReservations({ now = Date.now() } = {}) {
  const reservations = await getQuotaBurnReservations({ now });
  if (!reservations) {
    console.error('❌ Quota-burn could not read its pending reservations — leaving them for the next cycle');
    return { deferred: 'reservations unreadable', accepted: 0, refused: 0 };
  }
  const keys = Object.keys(reservations);
  if (!keys.length) return { accepted: 0, refused: 0 };

  const [queued, tasksByRequest] = await Promise.all([queuedRequestIds(), burnTasksByRequestId()]);
  // Either read failing means we cannot tell "still waiting" from "accepted"
  // from "refused". Leave every reservation exactly where it is.
  if (!queued || !tasksByRequest) return { deferred: 'schedule or task queue unreadable', accepted: 0, refused: 0 };

  let accepted = 0;
  let refused = 0;
  for (const key of keys) {
    const record = reservations[key];
    // Still on the schedule: the engines have not drained it yet. The cap keeps
    // counting it, and the step stays blocked from a second dispatch.
    if (queued.has(record.requestId)) continue;
    const task = tasksByRequest.get(record.requestId);
    if (task) {
      if (await settleAccepted(key, record, task, now)) accepted += 1;
      continue;
    }
    await settleRefused(key, record, 'the on-demand request produced no task', now);
    refused += 1;
  }
  return { accepted, refused };
}
