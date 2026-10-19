/**
 * Repository-wide merge-instant admission for participating runs on this install.
 * Sync, pregate, push and CI run outside the lease; it spans only the final
 * verify-and-merge, so holds take seconds (#10803).
 */
import { randomUUID } from 'node:crypto';
import { getOriginInfo } from '../lib/gitRemote.js';
import { isPlainObject } from '../lib/objects.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { PR_COMPLETIONS, leavesPrForHuman, resolvePrCompletion } from '../lib/prDisposition.js';
import { repositoryCleanupMergeTarget } from '../lib/recoveryMergeTarget.js';
import { createEventLoopLagProbe, phaseGroup, roundMs, systemClock } from '../lib/eventLoopLagProbe.js';

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
export const repositoryKey = (origin) => origin?.host && origin?.fullName
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

// A settled transaction is logged only at or above this duration; a deadline,
// pending or failed one always is. See docs/TROUBLESHOOTING.md for the fields.
export const SLOW_ADMISSION_MS = 1000;
let clock = systemClock;
let lagProbe = createEventLoopLagProbe({ clock });

/** Inject a deterministic clock; `null` restores the system clock. */
export function setMergeAdmissionClockForTests(next) {
  clock = next ?? systemClock;
  lagProbe = createEventLoopLagProbe({ clock });
}

const REPORTED_PHASES = ['queue', 'trustedState', 'stateLoad', 'origin', 'ownerRecovery', 'persistence'];
const REPORTED_STAGES = [['trustedState', 'read'], ['trustedState', 'parse'], ['persistence', 'prepare'],
  ['persistence', 'serialize'], ['persistence', 'write'], ['persistence', 'replace'], ['persistence', 'dirSync']];
const REPORTED_LAG_PHASES = ['queue', 'trustedState', 'persistence'];

async function transaction(work, operation) {
  // Lazy: almost every task-generator suite reaches prWatcher, even when no
  // pending merge exists. Admission needs runtime state only on the merge path.
  const { withStateLock, readMergeAdmissionStateForSafetyCheck, loadState, saveState } = await import('./cosState.js');
  const queuedAt = clock.now();
  // Each phase runs until the next begins; `phase.stage` names are its stages.
  const span = lagProbe.begin('queue');
  let started = false;
  let cancelled = false;
  let timerLateMs = 0;
  // Only fixed operation/phase names and bounded numeric timings reach logs.
  const report = (status) => {
    const summary = status === 'pending' ? span.snapshot() : span.end();
    if (status === 'settled' && summary.totalMs < SLOW_ADMISSION_MS) return;
    const log = status === 'failed' ? console.error : status === 'settled' ? console.log : console.warn;
    const phases = REPORTED_PHASES.map((name) => `${name}Ms=${phaseGroup(summary, name).ms}`);
    const stages = REPORTED_STAGES.map(([name, stage]) => `${stage}Ms=${summary.phases[`${name}.${stage}`]?.ms ?? 0}`);
    const lag = REPORTED_LAG_PHASES.map((name) => `${name}LagMs=${phaseGroup(summary, name).lagMs}`);
    log(`🚦 Merge admission operation=${operation} status=${status} phase=${summary.phase.split('.')[0]} phaseMs=${summary.phaseMs} totalMs=${summary.totalMs} ${phases.join(' ')} ${stages.join(' ')} loopLagMs=${summary.lagMs} loopLagMaxMs=${summary.lagMaxMs} ${lag.join(' ')} timerLateMs=${timerLateMs}`);
  };
  const measure = async (name, fn) => {
    span.mark(name);
    return fn();
  };
  const stage = (name) => (sub) => span.mark(`${name}.${sub}`);
  const overdue = () => roundMs(clock.now() - queuedAt - ADMISSION_QUEUE_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const expire = () => {
      cancelled = true;
      report('queue-timeout');
      resolve(refuse('state-queue-timeout'));
    };
    // A late timer is itself evidence of event-loop delay: record by how much.
    const timer = clock.setTimer(() => {
      timerLateMs = overdue();
      if (!started) expire();
      else report('pending');
    }, ADMISSION_QUEUE_TIMEOUT_MS);
    const queued = withStateLock(async () => {
      // Check the clock as well: a delayed timer must not let an expired
      // callback mutate a lease when the state queue resumes first.
      if (cancelled) return;
      if (clock.now() - queuedAt >= ADMISSION_QUEUE_TIMEOUT_MS) { timerLateMs = overdue(); expire(); return; }
      started = true;
      const snapshot = await measure('trustedState', () =>
        readMergeAdmissionStateForSafetyCheck({ onStage: stage('trustedState') }).catch(() => null));
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
      return work(next, (value) => measure('persistence', () => saveState(value, { onStage: stage('persistence') })), measure);
    });
    // Once started, the queue owns the entire transaction through durable
    // settlement. The deadline diagnoses a slow phase but cannot return a
    // refusal while an unfenced acquire/release is still able to commit.
    queued.then((result) => {
      if (!cancelled) { report('settled'); resolve(result); }
    }, (error) => {
      if (!cancelled) { report('failed'); reject(error); }
    }).finally(() => clock.clearTimer(timer));
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

const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

// The persisted task this live agent runs, or null once it is absent or final.
async function liveTask(agent) {
  const { getTaskById } = await import('./cosTaskStore.js');
  const task = await getTaskById(agent.taskId).catch(() => null);
  return task?.id === agent.taskId && !TERMINAL_TASK_STATUSES.includes(task.status) ? task : null;
}

// The registered checkout must still name this repository and have the
// assigned branch checked out; an unreadable checkout is not a match.
async function checkoutOnBranch(workspace, branch, repository) {
  if (repositoryKey(await getOriginInfo(workspace).catch(() => null)) !== repository) return false;
  const { execGit } = await import('../lib/execGit.js');
  const checkout = await execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspace).catch(() => null);
  return checkout?.stdout?.trim() === branch;
}

// Review-loop authority comes from the registered launch AND its live internal
// task. Never accept a repository/branch from the admission request or PR prose.
async function verifiedReviewCoordinator(agent, repository) {
  const target = agent.metadata?.reviewLoopMergeTarget;
  if (!isPlainObject(target) || typeof target.branch !== 'string' || !target.branch) return false;
  const task = await liveTask(agent);
  const meta = task?.metadata;
  if (!task || task.taskType !== 'internal'
    || !isTruthyMeta(meta?.reviewLoopFollowUp) || isTruthyMeta(meta?.reviewLoopLeaveOpen)
    || resolvePrCompletion(meta) === PR_COMPLETIONS.LEAVE_OPEN || agent.metadata?.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN
    || target.url !== meta?.reviewLoopPRUrl || target.branch !== meta?.reviewLoopPRBranch
    || agent.metadata?.worktreeBranch !== target.branch || !agent.metadata?.workspacePath) return false;
  const pr = parsePullRequestUrl(target.url);
  if (!pr || repositoryKey({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` }) !== repository
    || String(meta.reviewLoopPRNumber) !== String(pr.number)
    || meta.reviewLoopPRHost !== pr.host || meta.reviewLoopPROwner !== pr.owner || meta.reviewLoopPRRepo !== pr.repo) return false;
  if (!await checkoutOnBranch(agent.metadata.workspacePath, target.branch, repository)) return false;
  if (!meta.forkHead && !meta.reviewLoopForkTarget && !target.fork && !target.workspacePath) return true;
  if (target.workspacePath !== agent.metadata.workspacePath || !agent.metadata.sourceWorkspace
    || agent.metadata.sourceWorkspace === target.workspacePath || target.fork?.url !== target.url) return false;
  const { verifyForkReviewMergeTarget } = await import('./forkReviewMergeTarget.js');
  const headSha = await verifyForkReviewMergeTarget({ target: target.fork, taskTarget: meta.reviewLoopForkTarget,
    forkHead: meta.forkHead, sourceWorkspace: agent.metadata.sourceWorkspace,
    workspacePath: target.workspacePath, branch: target.branch });
  return headSha ? { headSha } : false;
}

// Generic PR delivery (#11435): an operator-configured task whose prompt told
// it to open AND merge its own PR from the worktree PortOS provisioned. The
// target is the spawn-time binding (that worktree and its head branch), never
// the request; the live task must still grant agent-owned delivery, and the
// checkout must still be that branch of this repository. A generic run cannot
// promote itself to claim authority: it admits only its own registered branch.
async function verifiedWorktreeDelivery(agent, repository) {
  const meta = agent.metadata;
  const target = meta?.prDeliveryTarget;
  if (!isPlainObject(target) || typeof target.branch !== 'string' || !target.branch
    || typeof target.workspacePath !== 'string' || !target.workspacePath) return false;
  const { PR_OPENED_BY } = await import('../lib/slashdoInvocation.js');
  if (meta.isWorktree !== true || meta.configOpenPR !== true || meta.configClaimFlow
    || ![PR_OPENED_BY.AGENT_SLASHDO, PR_OPENED_BY.AGENT_INLINE].includes(meta.prOpenedBy)
    || meta.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN
    || meta.worktreeBranch !== target.branch || meta.workspacePath !== target.workspacePath
    || !meta.sourceWorkspace || meta.sourceWorkspace === target.workspacePath) return false;
  const task = await liveTask(agent);
  const taskMeta = task?.metadata;
  if (!task || !isTruthyMeta(taskMeta?.openPR) || resolvePrCompletion(taskMeta) === PR_COMPLETIONS.LEAVE_OPEN
    || leavesPrForHuman(task) || isTruthyMeta(taskMeta?.reviewLoopFollowUp) || isTruthyMeta(taskMeta?.readOnly)
    || taskMeta?.forkHead) return false;
  return checkoutOnBranch(target.workspacePath, target.branch, repository);
}

const isCleanupRecovery = (agent) => agent.metadata?.isRecovery === true
  && agent.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup';

// Repository-cleanup recovery (#12251): lands the PR of the completed parent
// whose audit filed it. Its registered target must match the live task, and
// the parent must carry the server-written backlink to this task, branch and
// PR. Needs no checkout: the parent's worktree is usually already gone.
async function verifiedCleanupRecovery(agent, repository, agents) {
  const meta = agent.metadata;
  const target = meta.recoveryMergeTarget;
  const { parentAgentId, parentTaskId } = meta.recoveryOrigin;
  if (!isPlainObject(target) || !parentTaskId || meta.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN) return false;
  const task = await liveTask(agent);
  const live = repositoryCleanupMergeTarget(task);
  if (!live || live.url !== target.url || live.branch !== target.branch || leavesPrForHuman(task)
    || isTruthyMeta(task.metadata.readOnly) || task.metadata.recoveryOrigin.parentAgentId !== parentAgentId
    || task.metadata.recoveryOrigin.parentTaskId !== parentTaskId) return false;
  const pr = parsePullRequestUrl(target.url);
  if (repositoryKey({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` }) !== repository) return false;
  let parent = agents[parentAgentId];
  if (!parent) {
    const { readAgentRecordOrUnreadable } = await import('./cosAgentLifecycle.js');
    parent = await readAgentRecordOrUnreadable(parentAgentId);
  }
  const link = parent?.metadata?.repoStateRecovery;
  if (!isPlainObject(parent) || parent.id !== parentAgentId || parent.taskId !== parentTaskId || parent.status !== 'completed'
    || parent.metadata.worktreeBranch !== target.branch || parent.metadata.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN
    || !isPlainObject(link) || link.taskId !== agent.taskId || link.url !== target.url || link.branch !== target.branch
    || !parent.metadata.sourceWorkspace) return false;
  return repositoryKey(await getOriginInfo(parent.metadata.sourceWorkspace).catch(() => null)) === repository;
}

// Claim parents carry their registered claim binding; every other participant
// must prove its registered target against live task and checkout state.
async function verifiedParticipant(agent, repository, agents) {
  if (isTruthyMeta(agent.metadata?.claimPicksOwnBranch) || agent.metadata?.claimBranch) return true;
  if (isCleanupRecovery(agent)) return verifiedCleanupRecovery(agent, repository, agents);
  return await verifiedReviewCoordinator(agent, repository) || verifiedWorktreeDelivery(agent, repository);
}

/**
 * The registered run a pending-merge handoff may bind (#12247): the same live
 * participant proof acquire uses, plus which branch that run owns and the
 * registered checkout holding it (null for a claim run, which cuts its own).
 * Nothing here is taken from the request. Fork review targets are refused —
 * the coordinator merges same-repository heads only.
 */
export async function resolveMergeHandoffOwner(agentId) {
  const { readMergeAdmissionStateForSafetyCheck } = await import('./cosState.js');
  const snapshot = await readMergeAdmissionStateForSafetyCheck().catch(() => null);
  if (!snapshot?.trusted || !isPlainObject(snapshot.agents)) return { refused: 'ownership-unreadable' };
  const agent = snapshot.agents[agentId];
  if (!agent || agent.id !== agentId || agent.status !== 'running' || !agent.startedAt || !agent.taskId) {
    return { refused: 'handoff-owner-unverified' };
  }
  const repository = ownerPath(agent) ? repositoryKey(await getOriginInfo(ownerPath(agent)).catch(() => null)) : null;
  if (!repository) return { refused: 'repository-unreadable' };
  const task = await liveTask(agent);
  if (!task) return { refused: 'handoff-owner-unverified' };
  const meta = agent.metadata || {};
  if (meta.reviewLoopMergeTarget?.fork || task.metadata?.forkHead) return { refused: 'fork-target-unsupported' };
  const owner = { agent, task, repository };
  if (isTruthyMeta(meta.claimPicksOwnBranch) || meta.claimBranch) {
    const { ownsClaimBranch } = await import('../lib/claimContinuation.js');
    return { ...owner, owns: (branch) => ownsClaimBranch(agent, branch), workspacePath: null };
  }
  if (await verifiedReviewCoordinator(agent, repository) === true) {
    return { ...owner, owns: (branch) => branch === meta.reviewLoopMergeTarget.branch, workspacePath: meta.workspacePath };
  }
  if (await verifiedWorktreeDelivery(agent, repository)) {
    return { ...owner, owns: (branch) => branch === meta.prDeliveryTarget.branch, workspacePath: meta.prDeliveryTarget.workspacePath };
  }
  return { refused: 'handoff-owner-unverified' };
}

/** The ID is the registered parent, never a worker-child ID or a cwd PID. */
export async function claimMergeAdmission({ agentId, action, token, outcome }) {
  return transaction(async (state, save, measure) => {
    const agent = state.agents[agentId];
    if (!agent || agent.id !== agentId || agent.status !== 'running' || !agent.startedAt || !agent.taskId) {
      return refuse('claim-owner-unverified');
    }
    if (!ownerPath(agent)) return refuse('repository-unreadable');
    const repository = repositoryKey(await measure('origin', () => getOriginInfo(ownerPath(agent)).catch(() => null)));
    if (!repository) return refuse('repository-unreadable');
    // Releasing an owned token must remain possible after merge deletes or
    // switches the checkout. Acquire/check still require the assigned target.
    const participant = action === 'release' ? true : await measure('origin', () => verifiedParticipant(agent, repository, state.agents));
    if (!participant && isCleanupRecovery(agent)) {
      return { admitted: false, reason: 'recovery-merge-target-unverified', retryable: false,
        message: 'Leave the PR and branch intact and report this blocker: this recovery has no verified registered parent PR target. Retrying cannot change that; only a freshly filed recovery can.' };
    }
    if (!participant) {
      const task = await liveTask(agent);
      if (agent.metadata?.reviewLoopMergeTarget?.fork || (task?.taskType === 'internal'
        && isTruthyMeta(task.metadata?.reviewLoopFollowUp) && task.metadata?.forkHead)) {
        return { admitted: false, reason: 'fork-review-target-unverified', retryable: false,
          message: 'Leave the PR/worktree intact. Verify the live PR head, base, fork remote and upstream; old or changed targets require a fresh supported follow-up.' };
      }
      return refuse('claim-owner-unverified');
    }
    if (action === 'acquire') {
      if (Object.entries(state.mergeAdmissions).some(([key, held]) =>
        !validLease(held, key) || (held.agentId === agentId && (!sameAgent(held, agent) || key !== repository)))) {
        return refuse('lease-owner-mismatch');
      }
      const held = state.mergeAdmissions[repository];
      if (participant.headSha && held?.agentId === agentId && !expired(held) && held.headSha !== participant.headSha) return refuse('lease-head-changed');
      return admit(state, save, repository, { kind: 'agent', ...binding(agent),
        ...(participant.headSha ? { headSha: participant.headSha } : {}) }, measure);
    }
    const lease = state.mergeAdmissions[repository];
    if (!validLease(lease, repository) || lease.kind !== 'agent' || !sameAgent(lease, agent) || lease.token !== token) {
      return refuse('lease-owner-mismatch');
    }
    // An expired holder must stop and re-acquire before merging; releasing
    // its own still-unclaimed lease stays permitted.
    if (action === 'check' && participant.headSha && lease.headSha !== participant.headSha) return refuse('lease-head-changed');
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
