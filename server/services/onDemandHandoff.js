/** Durable handoff for asynchronous quota, maintenance and swarm refill requests. A nonce fences
 * settlement, while only a proven missing owner PID permits crash reconciliation.
 * Live or ambiguous owners never expire. All transitions share the schedule queue. */
import { randomUUID } from 'node:crypto';
import { loadSchedule, updateSchedule } from './taskScheduleStore.js';
import { quotaBurnProvenance } from '../lib/quotaBurnOrigin.js';

const owner = randomUUID();
const ownerPid = process.pid;

// ESRCH is proof of absence, unlike a different nonce or elapsed time. A reused
// PID conservatively remains held; permission/probe errors are not proof of death.
function ownerIsGone(claim) {
  if (claim.owner === owner || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid <= 0) return false;
  try { process.kill(claim.ownerPid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export async function claimOnDemandRequest(requestId) {
  return updateSchedule(async (schedule) => {
    const index = (schedule.onDemandRequests || []).findIndex(request => request.id === requestId);
    if (index < 0 || schedule.onDemandHandoffs?.[requestId]) return { result: null, changed: false };
    const [request] = schedule.onDemandRequests.splice(index, 1);
    schedule.onDemandHandoffs ??= {};
    const claim = { request, owner, ownerPid, token: randomUUID(), status: 'preparing', claimedAt: new Date().toISOString() };
    schedule.onDemandHandoffs[requestId] = claim;
    return { result: claim, changed: true };
  });
}

export async function settleOnDemandRequest(claim, { taskId = null, reason = null, retry = false } = {}) {
  return updateSchedule(async (schedule) => {
    const current = schedule.onDemandHandoffs?.[claim.request.id];
    if (current?.token !== claim.token || current.owner !== owner || current.ownerPid !== ownerPid || current.status !== 'preparing') {
      return { result: false, changed: false };
    }
    if (retry && current.request.cleanupSourceAgentId) {
      delete schedule.onDemandHandoffs[claim.request.id];
      schedule.onDemandRequests ||= [];
      if (!schedule.onDemandRequests.some(row => row.id === current.request.id)) schedule.onDemandRequests.push(current.request);
      return { result: true, changed: true };
    }
    Object.assign(current, { status: taskId ? 'accepted' : 'refused', taskId, reason, settledAt: new Date().toISOString() });
    const source = current.request.cleanupSourceAgentId;
    const pending = source && schedule.swarmCleanupRefillPending?.[source];
    if (pending?.id === current.request.id && pending.sourceMarked) delete schedule.swarmCleanupRefillPending[source];
    return { result: true, changed: true };
  });
}

/** Reconcile only proven dead owners. Reads of task storage must succeed, then
 * liveness is rechecked under the schedule queue before changing the claim. */
export async function reconcileOnDemandHandoffs() {
  const snapshot = await loadSchedule();
  if (!Object.values(snapshot.onDemandHandoffs || {}).some(claim => claim.status === 'preparing' && ownerIsGone(claim))) return;
  const { getAllTasks } = await import('./cosTaskStore.js');
  const { user, cos } = await getAllTasks();
  const tasks = [...(user?.tasks || []), ...(cos?.tasks || [])];
  await updateSchedule(async (schedule) => {
    let changed = false;
    for (const claim of Object.values(schedule.onDemandHandoffs || {})) {
      if (claim.status !== 'preparing' || !ownerIsGone(claim)) continue;
      const source = claim.request.cleanupSourceAgentId;
      if (source) {
        const task = tasks.find(entry => entry.id === `sys-swarm-refill-${source}`
          && entry.metadata?.cleanupRefillSource === source
          && entry.metadata?.idempotencyKey === `swarm-cleanup-refill:${source}`);
        if (task) {
          Object.assign(claim, { status: 'accepted', taskId: task.id, reason: null, settledAt: new Date().toISOString() });
          const pending = schedule.swarmCleanupRefillPending?.[source];
          if (pending?.id === claim.request.id && pending.sourceMarked) delete schedule.swarmCleanupRefillPending[source];
        } else {
          delete schedule.onDemandHandoffs[claim.request.id];
          schedule.onDemandRequests ||= [];
          if (!schedule.onDemandRequests.some(row => row.id === claim.request.id)) schedule.onDemandRequests.push(claim.request);
        }
        changed = true;
        continue;
      }
      const task = tasks.find(entry => quotaBurnProvenance(entry.metadata).requestId === claim.request.id);
      Object.assign(claim, { status: task ? 'accepted' : 'interrupted', taskId: task?.id ?? null,
        reason: task ? null : 'Server restarted during request preparation; resume explicitly.', settledAt: new Date().toISOString() });
      changed = true;
    }
    return { changed };
  });
}

export async function getOnDemandHandoffs() {
  await reconcileOnDemandHandoffs();
  return (await loadSchedule()).onDemandHandoffs || {};
}
