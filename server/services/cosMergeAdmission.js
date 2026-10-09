/**
 * Repository-wide merge-instant admission for participating runs on this install.
 * Sync, pregate, push and CI run outside the lease; it spans only the final
 * verify-and-merge, so holds take seconds (#10803).
 */
import { randomUUID } from 'node:crypto';
import { getOriginInfo } from '../lib/gitRemote.js';
import { isPlainObject } from '../lib/objects.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';

const retryAfterMs = 5000;
export const ADMISSION_QUEUE_TIMEOUT_MS = 15_000;
// An agent lease covers only verify-and-merge. Past this deadline it is
// reclaimable even from a running owner: that holder's pinned merge
// (--match-head-commit) cannot land an unverified head, so the worst case is
// one redundant resync rather than a repository blocked behind a hung parent.
// This is not a forge-side fence: a merge request already in flight at the
// deadline may still land, with the same exposure as two CLEAN merges.
export const AGENT_LEASE_MAX_HOLD_MS = 5 * 60 * 1000;
export const MERGE_ADMISSION_OUTCOMES = ['merged', 'leave-open', 'resync'];
const serverOwner = randomUUID();
const sweepTokens = new Set();
const refuse = (reason) => ({ admitted: false, reason, retryAfterMs });
const repositoryKey = (origin) => origin?.host && origin?.fullName
  ? `${origin.host.replace(/^ssh\.github\.com$/i, 'github.com')}/${origin.fullName}`.toLowerCase()
  : null;
const ownerPath = (agent) => agent?.metadata?.sourceWorkspace || agent?.sourceWorkspace
  || agent?.metadata?.workspacePath || agent?.workspacePath;
const binding = (agent) => ({ agentId: agent.id, startedAt: agent.startedAt, taskId: agent.taskId });
const sameAgent = (lease, agent) => agent?.id === lease.agentId && agent?.startedAt === lease.startedAt
  && agent?.taskId === lease.taskId;
const validLease = (lease, repository) => isPlainObject(lease) && lease.repository === repository
  && typeof lease.token === 'string' && lease.token.length > 0 && Number.isFinite(Date.parse(lease.acquiredAt))
  && (lease.kind === 'agent'
    ? typeof lease.agentId === 'string' && typeof lease.startedAt === 'string' && typeof lease.taskId === 'string'
    : lease.kind === 'sweep' && typeof lease.serverOwner === 'string' && Number.isInteger(lease.pid) && lease.pid > 0);
const expired = (lease) => lease.kind === 'agent' && Date.now() - Date.parse(lease.acquiredAt) >= AGENT_LEASE_MAX_HOLD_MS;

async function transaction(work, operation) {
  // Lazy: almost every task-generator suite reaches prWatcher, even when no
  // pending merge exists. Admission needs runtime state only on the merge path.
  const { withStateLock, readMergeAdmissionStateForSafetyCheck, loadState, saveState } = await import('./cosState.js');
  const queuedAt = performance.now();
  let started = false;
  let cancelled = false;
  let phase = 'queue';
  let phaseStartedAt = queuedAt;
  const timings = { queue: 0, trustedState: 0, stateLoad: 0, origin: 0, ownerRecovery: 0, persistence: 0 };
  const elapsed = (since) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() - since)));
  // Only fixed operation/phase names and bounded numeric timings reach logs.
  const report = (status) => {
    const log = status === 'failed' ? console.error : status === 'settled' ? console.log : console.warn;
    log(`🚦 Merge admission operation=${operation} status=${status} phase=${phase} phaseMs=${elapsed(phaseStartedAt)} totalMs=${elapsed(queuedAt)} queueMs=${timings.queue} trustedStateMs=${timings.trustedState} stateLoadMs=${timings.stateLoad} originMs=${timings.origin} ownerRecoveryMs=${timings.ownerRecovery} persistenceMs=${timings.persistence}`);
  };
  const measure = async (name, fn) => {
    phase = name;
    phaseStartedAt = performance.now();
    try { return await fn(); }
    finally { timings[name] = elapsed(phaseStartedAt); }
  };
  return new Promise((resolve, reject) => {
    const expire = () => {
      cancelled = true;
      timings.queue = elapsed(queuedAt);
      report('queue-timeout');
      resolve(refuse('state-queue-timeout'));
    };
    const timer = setTimeout(() => {
      if (!started) expire();
      else report('pending');
    }, ADMISSION_QUEUE_TIMEOUT_MS);
    const queued = withStateLock(async () => {
      // Check the clock as well: a delayed timer must not let an expired
      // callback mutate a lease when the state queue resumes first.
      if (cancelled) return;
      if (performance.now() - queuedAt >= ADMISSION_QUEUE_TIMEOUT_MS) { expire(); return; }
      started = true;
      timings.queue = elapsed(queuedAt);
      const snapshot = await measure('trustedState', () => readMergeAdmissionStateForSafetyCheck().catch(() => null));
      if (!snapshot?.trusted || !isPlainObject(snapshot.agents) || !isPlainObject(snapshot.mergeAdmissions)) {
        return refuse('ownership-unreadable');
      }
      const state = await measure('stateLoad', loadState);
      // A recovered/defaulted or externally replaced state is not proof of an
      // empty ownership set. Do not let the cache overwrite contradictory disk.
      if (JSON.stringify(state.agents) !== JSON.stringify(snapshot.agents)
        || JSON.stringify(state.mergeAdmissions ?? {}) !== JSON.stringify(snapshot.mergeAdmissions)) {
        return refuse('ownership-stale');
      }
      // Copy before mutation: a failed atomic write must not admit from a cache
      // that falsely remembers a successful grant/release.
      const next = { ...state, agents: { ...state.agents }, mergeAdmissions: { ...snapshot.mergeAdmissions } };
      return work(next, (value) => measure('persistence', () => saveState(value)), measure);
    });
    // Once started, the queue owns the entire transaction through durable
    // settlement. The deadline diagnoses a slow phase but cannot return a
    // refusal while an unfenced acquire/release is still able to commit.
    queued.then((result) => {
      if (!cancelled) { report('settled'); resolve(result); }
    }, (error) => {
      if (!cancelled) { report('failed'); reject(error); }
    }).finally(() => clearTimeout(timer));
  });
}

async function inactive(lease, state) {
  if (lease.kind === 'sweep') {
    if (lease.serverOwner === serverOwner) return !sweepTokens.has(lease.token);
    // Never expire on age: the sweep holds only its own bounded merge attempt.
    // A different server incarnation is recoverable only once its process is
    // proven absent.
    try { process.kill(lease.pid, 0); return false; }
    catch (err) { return err.code === 'ESRCH'; }
  }
  if (expired(lease)) return true;
  let owner = state.agents[lease.agentId];
  if (!owner) {
    const { readAgentRecordOrUnreadable } = await import('./cosAgentLifecycle.js');
    owner = await readAgentRecordOrUnreadable(lease.agentId);
  }
  return sameAgent(lease, owner) && owner.status === 'completed' && Number.isFinite(Date.parse(owner.completedAt));
}

async function admit(state, save, repository, owner, measure) {
  const held = state.mergeAdmissions[repository];
  if (Object.hasOwn(state.mergeAdmissions, repository)) {
    if (!validLease(held, repository)) return refuse('lease-unreadable');
    // Re-entry keeps a live token; an expired one is voided and re-minted below.
    if (owner.kind === 'agent' && held.kind === 'agent' && held.agentId === owner.agentId && held.startedAt === owner.startedAt
      && held.taskId === owner.taskId && !expired(held)) {
      return { admitted: true, token: held.token, repository };
    }
    if (!await measure('ownerRecovery', () => inactive(held, state))) return refuse('owner-active-or-unverified');
  }
  const lease = { ...owner, repository, token: randomUUID(), acquiredAt: new Date().toISOString() };
  state.mergeAdmissions[repository] = lease;
  if (owner.kind === 'sweep') sweepTokens.add(lease.token);
  await save(state);
  return { admitted: true, token: lease.token, repository };
}

/** The ID is the registered parent, never a worker-child ID or a cwd PID. */
export async function claimMergeAdmission({ agentId, action, token, outcome }) {
  return transaction(async (state, save, measure) => {
    const agent = state.agents[agentId];
    if (!agent || agent.id !== agentId || agent.status !== 'running' || !agent.startedAt || !agent.taskId
      || !(isTruthyMeta(agent.metadata?.claimPicksOwnBranch) || agent.metadata?.claimBranch)) {
      return refuse('claim-owner-unverified');
    }
    if (!ownerPath(agent)) return refuse('repository-unreadable');
    const repository = repositoryKey(await measure('origin', () => getOriginInfo(ownerPath(agent)).catch(() => null)));
    if (!repository) return refuse('repository-unreadable');
    if (action === 'acquire') {
      if (Object.entries(state.mergeAdmissions).some(([key, held]) =>
        !validLease(held, key) || (held.agentId === agentId && (!sameAgent(held, agent) || key !== repository)))) {
        return refuse('lease-owner-mismatch');
      }
      return admit(state, save, repository, { kind: 'agent', ...binding(agent) }, measure);
    }
    const lease = state.mergeAdmissions[repository];
    if (!validLease(lease, repository) || lease.kind !== 'agent' || !sameAgent(lease, agent) || lease.token !== token) {
      return refuse('lease-owner-mismatch');
    }
    // An expired holder must stop and re-acquire before merging; releasing
    // its own still-unclaimed lease stays permitted.
    if (action === 'check') return expired(lease) ? refuse('lease-expired') : { admitted: true, token, repository };
    if (action !== 'release' || !MERGE_ADMISSION_OUTCOMES.includes(outcome)) return refuse('outcome-required');
    delete state.mergeAdmissions[repository];
    state.agents[agentId] = { ...agent, metadata: { ...agent.metadata,
      lastMergeAdmission: { repository, outcome, releasedAt: new Date().toISOString() },
    } };
    await save(state);
    return { admitted: false, released: true, outcome };
  }, ['acquire', 'check', 'release'].includes(action) ? action : 'unknown');
}

/** A sweep holds admission only around its final read/assessment/merge attempt. */
export async function withPendingMergeAdmission(origin, work) {
  const repository = repositoryKey(origin);
  if (!repository) return refuse('repository-unreadable');
  const admission = await transaction((state, save, measure) => admit(state, save, repository, {
    kind: 'sweep', serverOwner, pid: process.pid,
  }, measure), 'sweep-acquire');
  if (!admission.admitted) return admission;
  try {
    return { admitted: true, result: await work() };
  } finally {
    try {
      const released = await transaction(async (state, save) => {
        const lease = state.mergeAdmissions[repository];
        if (!validLease(lease, repository) || lease.token !== admission.token) return refuse('lease-owner-mismatch');
        delete state.mergeAdmissions[repository];
        await save(state);
        return { released: true };
      }, 'sweep-release');
      if (!released.released) console.error(`❌ Pending merge admission release withheld: ${released.reason}`);
    } finally {
      // The callback has stopped even if persistence failed. Keep the durable
      // lease on disk; the next trusted transaction can prove this owner idle.
      sweepTokens.delete(admission.token);
    }
  }
}
