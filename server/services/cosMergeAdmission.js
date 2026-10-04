/** Repository-wide final-merge admission for participating runs on this install. */
import { randomUUID } from 'node:crypto';
import { getOriginInfo } from '../lib/gitRemote.js';
import { isPlainObject } from '../lib/objects.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';

const retryAfterMs = 15000;
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

async function transaction(work) {
  // Lazy: almost every task-generator suite reaches prWatcher, even when no
  // pending merge exists. Admission needs runtime state only on the merge path.
  const { withStateLock, readMergeAdmissionStateForSafetyCheck, loadState, saveState } = await import('./cosState.js');
  return withStateLock(async () => {
    const snapshot = await readMergeAdmissionStateForSafetyCheck().catch(() => null);
    if (!snapshot?.trusted || !isPlainObject(snapshot.agents) || !isPlainObject(snapshot.mergeAdmissions)) {
      return refuse('ownership-unreadable');
    }
    const state = await loadState();
    // A recovered/defaulted or externally replaced state is not proof of an
    // empty ownership set. Do not let the cache overwrite contradictory disk.
    if (JSON.stringify(state.agents) !== JSON.stringify(snapshot.agents)
      || JSON.stringify(state.mergeAdmissions ?? {}) !== JSON.stringify(snapshot.mergeAdmissions)) {
      return refuse('ownership-stale');
    }
    // Copy before mutation: a failed atomic write must not admit from a cache
    // that falsely remembers a successful grant/release.
    const next = { ...state, agents: { ...state.agents }, mergeAdmissions: { ...snapshot.mergeAdmissions } };
    return work(next, saveState);
  });
}

async function inactive(lease, state) {
  if (lease.kind === 'sweep') {
    if (lease.serverOwner === serverOwner) return !sweepTokens.has(lease.token);
    // Never expire on age: a long CI wait is legitimate. A different server
    // incarnation is recoverable only once its process is proven absent.
    try { process.kill(lease.pid, 0); return false; }
    catch (err) { return err.code === 'ESRCH'; }
  }
  let owner = state.agents[lease.agentId];
  if (!owner) {
    const { readAgentRecordOrUnreadable } = await import('./cosAgentLifecycle.js');
    owner = await readAgentRecordOrUnreadable(lease.agentId);
  }
  return sameAgent(lease, owner) && owner.status === 'completed' && Number.isFinite(Date.parse(owner.completedAt));
}

async function admit(state, save, repository, owner) {
  const held = state.mergeAdmissions[repository];
  if (Object.hasOwn(state.mergeAdmissions, repository)) {
    if (!validLease(held, repository)) return refuse('lease-unreadable');
    if (owner.kind === 'agent' && held.kind === 'agent' && held.agentId === owner.agentId && held.startedAt === owner.startedAt && held.taskId === owner.taskId) {
      return { admitted: true, token: held.token, repository };
    }
    if (!await inactive(held, state)) return refuse('owner-active-or-unverified');
  }
  const lease = { ...owner, repository, token: randomUUID(), acquiredAt: new Date().toISOString() };
  state.mergeAdmissions[repository] = lease;
  if (owner.kind === 'sweep') sweepTokens.add(lease.token);
  await save(state);
  return { admitted: true, token: lease.token, repository };
}

/** The ID is the registered parent, never a worker-child ID or a cwd PID. */
export async function claimMergeAdmission({ agentId, action, token, outcome }) {
  return transaction(async (state, save) => {
    const agent = state.agents[agentId];
    if (!agent || agent.id !== agentId || agent.status !== 'running' || !agent.startedAt || !agent.taskId
      || !(isTruthyMeta(agent.metadata?.claimPicksOwnBranch) || agent.metadata?.claimBranch)) {
      return refuse('claim-owner-unverified');
    }
    if (!ownerPath(agent)) return refuse('repository-unreadable');
    const repository = repositoryKey(await getOriginInfo(ownerPath(agent)).catch(() => null));
    if (!repository) return refuse('repository-unreadable');
    if (action === 'acquire') {
      if (Object.entries(state.mergeAdmissions).some(([key, held]) =>
        !validLease(held, key) || (held.agentId === agentId && (!sameAgent(held, agent) || key !== repository)))) {
        return refuse('lease-owner-mismatch');
      }
      return admit(state, save, repository, { kind: 'agent', ...binding(agent) });
    }
    const lease = state.mergeAdmissions[repository];
    if (!validLease(lease, repository) || lease.kind !== 'agent' || !sameAgent(lease, agent) || lease.token !== token) {
      return refuse('lease-owner-mismatch');
    }
    if (action === 'check') return { admitted: true, token, repository };
    if (action !== 'release' || !['merged', 'leave-open'].includes(outcome)) return refuse('outcome-required');
    delete state.mergeAdmissions[repository];
    state.agents[agentId] = { ...agent, metadata: { ...agent.metadata,
      lastMergeAdmission: { repository, outcome, releasedAt: new Date().toISOString() },
    } };
    await save(state);
    return { admitted: false, released: true, outcome };
  });
}

/** A sweep holds admission only around its final read/assessment/merge attempt. */
export async function withPendingMergeAdmission(origin, work) {
  const repository = repositoryKey(origin);
  if (!repository) return refuse('repository-unreadable');
  const admission = await transaction((state, save) => admit(state, save, repository, {
    kind: 'sweep', serverOwner, pid: process.pid,
  }));
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
      });
      if (!released.released) console.error(`❌ Pending merge admission release withheld: ${released.reason}`);
    } finally {
      // The callback has stopped even if persistence failed. Keep the durable
      // lease on disk; the next trusted transaction can prove this owner idle.
      sweepTokens.delete(admission.token);
    }
  }
}
