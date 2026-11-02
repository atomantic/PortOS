/** Machine-local publication outbox. It owns work, never merge or deletion authority.
 * Keep immutable dispatches after completion: queue history retention is not an
 * idempotency boundary, and a failed run does not unpublish a release.
 */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { isCurrentRetirementCheckout, retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { z } from 'zod';
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { RELEASE_SYNC_POLICY_KEYS, RELEASE_SYNC_FROZEN_METADATA_KEYS, RELEASE_SYNC_OBLIGATIONS,
  effectiveReleaseSynchronization, isInlineReleaseOwner, isInlineReleaseSynchronization, publisherCandidateSeed, publisherCandidateTarget,
  releaseSynchronizationReset, releaseSynchronizationResetSchema, resetReleasesCheckout } from '../lib/releaseSynchronization.js';
import { currentTaskTypeName } from '../lib/taskTypeRenames.js';
import { explicitPrCompletion, resolveAppPrCompletion } from '../lib/prDisposition.js';
import { storedForm } from '../lib/cosTaskRows.js';
import { cosEvents } from './cosEvents.js';

const queue = createFileWriteQueue();
const identitySchema = z.string().regex(/^[a-f0-9]{64}$/);
const ownerSchema = z.object({ agentId: z.string().min(1), taskId: z.string().min(1), startedAt: z.string().datetime(), workspace: z.string().min(1) }).strict();
const obligationSchema = z.object({ status: z.enum(['pending', 'blocked', 'verified']),
  verifiedAt: z.string().datetime().optional(), blocker: z.string().optional(), evidence: z.record(z.string(), z.unknown()).optional() }).strict()
  .refine(value => value.status !== 'verified' || (value.verifiedAt && value.evidence && Object.keys(value.evidence).length > 0));
const deliverySchema = z.object({ status: z.literal('verified'), number: z.number().int().positive().safe(), prUrl: z.string().url(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/), mergeSha: z.string().regex(/^[a-f0-9]{40}$/), base: z.string().min(1),
  developmentHead: z.string().regex(/^[a-f0-9]{40}$/), publishedVersion: z.string(), developmentVersion: z.string(),
  manifestBlob: z.string().regex(/^[a-f0-9]{40}$/), lockBlob: z.string().regex(/^[a-f0-9]{40}$/).nullable(), checkedAt: z.string().datetime() }).strict();
const entrySchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), identity: identitySchema, owner: ownerSchema,
  publication: z.object({ identity: identitySchema, status: z.literal('verified') }).passthrough(),
  task: z.object({ id: z.string(), metadata: z.object({ releaseSynchronization: z.object({ identity: identitySchema }).passthrough() }).passthrough() }).passthrough(),
  obligations: z.object(Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(key => [key, obligationSchema]))).strict(),
  synchronization: z.object({ status: z.enum(['pending', 'running', 'blocked', 'verified']),
    attempts: z.number().int().nonnegative(), checkedAt: z.string().datetime(), retryAt: z.string().datetime().nullable(),
    verifiedAt: z.string().datetime().nullable(), blocker: z.string().nullable(), delivery: deliverySchema.optional() }).strict().optional(),
  // Accepted pre-#14345 archive recoveries stay readable; they no longer bind a checkout.
  legacyRecovery: z.record(z.string(), z.unknown()).optional(),
  operatorReset: releaseSynchronizationResetSchema.optional(),
  checkouts: z.array(z.unknown()), registeredAt: z.string().datetime().nullable(),
  attempts: z.number().int().nonnegative(), lastAttemptAt: z.string().datetime().nullable(),
  blocker: z.string().nullable(), retryAt: z.string().datetime().nullable(),
}).strict();
const outboxSchema = z.object({ version: z.literal(1), publications: z.record(identitySchema, entrySchema) }).strict();
// Historical outboxes without either field never captured their app default.
// A roster alone cannot tell us whether review or an intentional merge-only run was authorized.
const hasFrozenPrDisposition = metadata => explicitPrCompletion({ metadata }) !== null
  || [true, false, 'true', 'false'].includes(metadata?.reviewLoop);
const refuse = message => { throw new ServerError(message, { status: 409, code: 'RELEASE_SYNC_HANDOFF_UNVERIFIED' }); };

async function readOutbox() {
  const value = await readReleaseSynchronizationOutbox();
  const parsed = outboxSchema.safeParse(value);
  if (!parsed.success || Object.entries(parsed.data.publications).some(([key, entry]) => key !== entry.identity
    || entry.publication.identity !== key
    || entry.task.id !== (isInlineReleaseSynchronization(entry) ? entry.owner.taskId : `task-release-sync-${key}`)
    || (isInlineReleaseSynchronization(entry) && entry.publication.synchronizationHandoffVersion !== 2)
    || entry.task.metadata.releaseSynchronization.identity !== key
    || (entry.synchronization?.status === 'verified' && RELEASE_SYNC_OBLIGATIONS.some(name => entry.obligations[name].status !== 'verified')))) refuse('Release synchronization outbox is unreadable');
  return parsed.data;
}

/** Continuations belong to an already authorized publication, not the schedule
 * that generates new releases. Keep the existing immutable task binding, and
 * serialize a subsequent release behind unfinished synchronization for its app.
 */
export async function releaseTaskDispatchDisposition(task, { ignoreAgentId = null, deliveryObservations = null } = {}) {
  const type = currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType);
  if (!['release-sync', 'do-release'].includes(type)) return null;
  const outbox = await readOutbox();
  if (type === 'do-release') {
    const candidates = Object.values(outbox.publications).filter(entry => entry.task.metadata.app === task.metadata?.app
      && !releaseSynchronizationReset(entry) && effectiveReleaseSynchronization(entry)?.status !== 'verified');
    const pending = [];
    for (const entry of candidates) {
      if (isInlineReleaseSynchronization(entry) && entry.owner.taskId === task.id) { pending.push(entry); continue; }
      if (!await releaseDeliveredAndIdle(entry, ignoreAgentId, deliveryObservations)) pending.push(entry);
    }
    if (pending.some(entry => !isInlineReleaseSynchronization(entry) || entry.owner.taskId !== task.id)) return 'wait-for-synchronization';
    return pending.length ? 'registered-release-owner' : null;
  }
  const entry = outbox.publications[task.metadata?.releaseSynchronization?.identity];
  if (!entry || task.id !== entry.task.id) return null;
  if (releaseSynchronizationReset(entry)) return 'retired-continuation';
  if (entry.synchronization?.delivery) return 'delivered-continuation';
  if (!hasFrozenPrDisposition(entry.task.metadata)) return 'review-policy-unverified';
  if (!entry.registeredAt) return null;
  const expected = { ...entry.task.metadata,
    idempotencyKey: createHash('sha256').update(JSON.stringify([entry.identity, entry.owner])).digest('hex') };
  return RELEASE_SYNC_FROZEN_METADATA_KEYS.every(key => isDeepStrictEqual(task.metadata?.[key], expected[key]))
    ? 'registered-continuation' : null;
}

function deliveryPrNumber(entry) {
  const original = entry.obligations.synchronizationPr;
  if (!isInlineReleaseSynchronization(entry) && entry.synchronization?.delivery) return entry.synchronization.delivery.number;
  const required = RELEASE_SYNC_OBLIGATIONS.filter(name => !['processSettlement', 'retirement'].includes(name));
  return required.every(name => entry.obligations[name]?.status === 'verified'
    && entry.obligations[name].evidence?.prUrl === original?.evidence?.prUrl
    && entry.obligations[name].evidence?.headSha === original?.evidence?.headSha)
    && Number.isSafeInteger(original?.evidence?.number) ? original.evidence.number : null;
}

function deliveryMatchesQuality(entry, proof) {
  return Boolean(entry.synchronization?.delivery && !isInlineReleaseSynchronization(entry))
    || entry.obligations.qualitySnapshot?.evidence?.developmentHead === proof?.developmentHead;
}

/** Observe the forge before entering the short spawn ownership fence. */
export async function observeReleaseDeliveries(task, { ignoreAgentId = null } = {}) {
  if (currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType) !== 'do-release') return new Map();
  const outbox = await readOutbox();
  const { inspectReleaseDelivery } = await import('./releaseSynchronizationEvidence.js');
  const observations = new Map();
  for (const entry of Object.values(outbox.publications).filter(value => value.task.metadata.app === task.metadata?.app
    && !releaseSynchronizationReset(value) && effectiveReleaseSynchronization(value)?.status !== 'verified'
    && !(isInlineReleaseSynchronization(value) && value.owner.taskId === task.id))) {
    const number = deliveryPrNumber(entry);
    if (!number) continue;
    const ownerState = await releaseOwnersIdle(entry, ignoreAgentId);
    if (!ownerState) continue;
    const proof = await inspectReleaseDelivery(entry, number).catch(() => null);
    if (proof && deliveryMatchesQuality(entry, proof)) observations.set(entry.identity, { ...proof, ownerState });
  }
  return observations;
}

async function releaseOwnersIdle(entry, ignoreAgentId = null, observed = null) {
  const { readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
  const agents = await readClaimOwnershipAgents();
  if (!agents) return false;
  const { getActiveAgentIds } = await import('./agentState.js');
  const related = agent => agent.id === entry.owner.agentId || agent.taskId === entry.owner.taskId || agent.taskId === entry.task.id;
  const history = observed?.owners || await (await import('./branchCompletionPolicy.js')).readBranchCompletionPolicies({ repairIndex: false }).catch(() => null);
  if (!history) return false;
  const owners = [...new Map([...history.filter(related), ...agents.filter(related)].map(agent => [agent.id, agent])).values()];
  const binding = owner => [owner.id, owner.taskId, owner.startedAt, owner.completedAt, owner.pid,
    owner.metadata?.useRunner, owner.metadata?.executionMode];
  if (observed && !isDeepStrictEqual(owners.map(binding).sort(), observed.owners.map(binding).sort())) return false;
  let runnerAgents = observed?.runnerAgents || [];
  const runnerBacked = agent => agent.metadata?.useRunner === true || agent.metadata?.useRunner === 'true'
    || ['runner', 'runner-tui'].includes(agent.metadata?.executionMode);
  const known = [...new Map([...history, ...agents].map(agent => [agent.id, agent])).values()];
  const releaseAgents = known.filter(agent => runnerBacked(agent) && ['do-release', 'release-sync'].includes(currentTaskTypeName(
    agent.metadata?.taskAnalysisType || agent.metadata?.analysisType || agent.metadata?.selfImprovementType)));
  const relevantRunners = [];
  if (!observed) for (const agent of releaseAgents) {
    if (related(agent)) { relevantRunners.push(agent); continue; }
    const scope = await sameReleaseScope(entry, agent);
    if (scope !== false) relevantRunners.push(agent);
  }
  if (!observed && [...relevantRunners, ...owners].some(runnerBacked)) {
    const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
    const running = await getActiveAgentsFromRunner().catch(() => null);
    if (!Array.isArray(running) || running.some(agent => !agent || typeof agent.id !== 'string')) return false;
    const { runnerEntryShieldsRunningRecord } = await import('../lib/runnerAgentLiveness.js');
    const live = await Promise.all(running.map(agent => runnerEntryShieldsRunningRecord(agent)));
    const ids = running.filter((_, index) => live[index]).map(agent => agent.id);
    if (ids.some(id => !known.some(agent => agent.id === id))) return false;
    runnerAgents = known.filter(agent => ids.includes(agent.id));
  }
  const active = new Set([...getActiveAgentIds(), ...runnerAgents.map(agent => agent.id)].filter(id => id !== ignoreAgentId));
  if ([...active].some(id => !agents.some(agent => agent.id === id) && !runnerAgents.some(agent => agent.id === id))) return false;
  if (!owners.some(agent => agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt)
    || owners.some(agent => agent.status !== 'completed' || active.has(agent.id) || !Number.isFinite(Date.parse(agent.completedAt))
      || Date.parse(agent.completedAt) < Date.parse(agent.startedAt) || Date.parse(agent.completedAt) > Date.now())) return false;
  const safeOthers = new Map();
  const runningAgents = [...new Map([...runnerAgents, ...agents].map(agent => [agent.id, agent])).values()];
  for (const agent of runningAgents.filter(value => value.status !== 'completed' || active.has(value.id))) {
    let type = currentTaskTypeName(agent.metadata?.taskAnalysisType || agent.metadata?.analysisType || agent.metadata?.selfImprovementType);
    let task;
    if (!type) {
      if (!agent.taskId) return false;
      const { getTaskById } = await import('./cosTaskStore.js');
      task = await getTaskById(agent.taskId);
      type = currentTaskTypeName(task?.metadata?.analysisType || task?.metadata?.selfImprovementType);
      if (!type && task?.taskType !== 'user') return false;
    }
    if (!['do-release', 'release-sync'].includes(type)) continue;
    const workspace = agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
    const scopeBinding = [agent.id, agent.taskId, agent.startedAt, type, agent.metadata?.taskApp || agent.metadata?.app || task?.metadata?.app, workspace];
    if (observed) {
      if (!observed.safeOthers.has(agent.id) || !isDeepStrictEqual(observed.safeOthers.get(agent.id), scopeBinding)) return false;
      continue;
    }
    if (await sameReleaseScope(entry, agent, task) !== false) return false;
    safeOthers.set(agent.id, scopeBinding);
  }
  const { listAllSessions } = await import('./shell.js');
  if (listAllSessions().some(session => owners.some(owner => owner.id === session.agentId))) return false;
  if (!observed && process.platform === 'win32') {
    const { readWindowsAgentSettlement } = await import('../lib/windowsAgentProcess.js');
    for (const owner of owners) if (!await readWindowsAgentSettlement(owner).catch(() => null)) return false;
  } else if (process.platform !== 'win32') {
    for (const owner of owners.filter(value => Number.isSafeInteger(value.pid) && value.pid > 0)) {
      try { process.kill(owner.pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
    }
  }
  return { owners, runnerAgents, safeOthers: observed?.safeOthers || safeOthers };
}

async function sameReleaseScope(entry, agent, task = null) {
  const app = agent.metadata?.taskApp || agent.metadata?.app || task?.metadata?.app;
  if (app && app === entry.task.metadata.app) return true;
  const workspace = agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
  const [repo, other] = await Promise.all([realpath(entry.owner.workspace).catch(() => null), workspace && realpath(workspace).catch(() => null)]);
  if (!repo || !other) return null;
  if (samePath(repo, other)) return true;
  const { execGit } = await import('../lib/execGit.js');
  const common = async path => {
    const result = await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], path, { ignoreExitCode: true }).catch(() => null);
    return result?.exitCode === 0 ? realpath(result.stdout.trim()).catch(() => null) : null;
  };
  const [left, right] = await Promise.all([common(repo), common(other)]);
  return left && right ? samePath(left, right) : null;
}

async function releaseDeliveredAndIdle(entry, ignoreAgentId = null, observations = null) {
  const number = deliveryPrNumber(entry);
  if (!number) return false;
  if (observations) {
    const proof = observations.get(entry.identity);
    const expected = entry.synchronization?.delivery || entry.obligations.synchronizationPr?.evidence;
    if (proof?.number !== number || proof.headSha !== expected?.headSha || proof.mergeSha !== expected?.mergeSha
      || !proof.ownerState || !deliveryMatchesQuality(entry, proof)) return false;
  }
  if (!await releaseOwnersIdle(entry, ignoreAgentId, observations?.get(entry.identity)?.ownerState)) return false;
  if (observations) return true;
  const { inspectReleaseDelivery } = await import('./releaseSynchronizationEvidence.js');
  const proof = await inspectReleaseDelivery(entry, number).catch(() => null);
  return Boolean(proof && deliveryMatchesQuality(entry, proof));
}

/** Exclude only delivered, inactive release tasks from scheduler deduplication. */
export async function deliveredReleaseTaskIds(tasks, { deliveryObservations = null, revalidate = true } = {}) {
  const relevant = tasks.filter(task => ['blocked', 'in_progress'].includes(task.status)
    && ['do-release', 'release-sync'].includes(currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType)));
  if (!relevant.length) return new Set();
  const outbox = await readOutbox();
  const delivered = new Set();
  for (const task of relevant) {
    const entry = Object.values(outbox.publications).find(value => value.task.id === task.id);
    if (entry && (revalidate ? await releaseDeliveredAndIdle(entry, null, deliveryObservations)
      : deliveryPrNumber(entry) && await releaseOwnersIdle(entry))) delivered.add(task.id);
  }
  return delivered;
}

/** Observe a replacement delivery without changing the historical task verdict. */
export async function verifyIndependentReleaseDelivery(identity, number) {
  const initial = (await readOutbox()).publications[identity];
  if (!initial || !initial.registeredAt || !initial.synchronization || releaseSynchronizationReset(initial)) refuse('Release synchronization was not found or is retired');
  if (isInlineReleaseSynchronization(initial)) refuse('Independent repair verification is only available for historical continuations');
  const { inspectReleaseDelivery } = await import('./releaseSynchronizationEvidence.js');
  const observation = await inspectReleaseDelivery(initial, number).catch(error => refuse(`Release delivery could not be verified: ${error.code || 'evidence-unavailable'}`));
  const delivery = deliverySchema.parse(observation);
  const ownerState = await releaseOwnersIdle(initial);
  if (!ownerState) refuse('A release or synchronization is still active or ownership is unavailable');
  const updated = await queue(async () => {
    const { withClaimOwnershipLock } = await import('./cosClaimOwnershipState.js');
    return withClaimOwnershipLock(async () => {
      const entry = (await readOutbox()).publications[identity];
      if (!entry || !entry.registeredAt || !entry.synchronization || releaseSynchronizationReset(entry)
        || !isDeepStrictEqual(entry.publication, initial.publication) || !isDeepStrictEqual(entry.owner, initial.owner)
        || entry.task.id !== initial.task.id || entry.task.metadata.app !== initial.task.metadata.app) refuse('Release synchronization changed during verification');
      if (!await releaseOwnersIdle(entry, null, ownerState)) refuse('A release or synchronization is still active or ownership is unavailable');
      entry.synchronization = { ...entry.synchronization, delivery };
      await saveReleaseSynchronization(entry);
      return entry;
    });
  });
  await emitReleaseSynchronization(updated, ownerState.owners, { suppressCompletionWake: true }).catch(error => {
    console.log(`🚫 Release delivery update could not be broadcast: ${error.code || 'notification-unavailable'}`);
  });
  return delivery;
}

/** Retire one stale checkpoint; retain its original verdict and publication. */
export function resetReleaseSynchronization(identity, reason, actor, checkouts = []) {
  return queue(async () => {
    const { withClaimOwnershipLock, readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
    return withClaimOwnershipLock(async () => {
      const entry = (await readOutbox()).publications[identity];
      if (!entry) refuse('Release synchronization was not found');
      const previous = releaseSynchronizationReset(entry);
      if (previous) {
        if (previous.reason !== reason || previous.actor !== actor || !isDeepStrictEqual(previous.checkouts, checkouts)) refuse('A different operator reset was already recorded');
        await parkRetiredContinuation(entry);
        return previous;
      }
      const synchronization = effectiveReleaseSynchronization(entry);
      if (synchronization?.status === 'verified') refuse('Release synchronization is already verified');
      const agents = await readClaimOwnershipAgents();
      if (!agents) refuse('Release ownership is unavailable');
      const { getActiveAgentIds } = await import('./agentState.js');
      const active = new Set(getActiveAgentIds());
      const repo = await realpath(entry.owner.workspace).catch(() => null);
      if (!repo) refuse('Release repository is unavailable');
      if (agents.some(agent => agent.metadata?.useRunner === true || agent.metadata?.useRunner === 'true'
        || ['runner', 'runner-tui'].includes(agent.metadata?.executionMode))) {
        const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
        const running = await getActiveAgentsFromRunner();
        if (!Array.isArray(running) || running.some(agent => !agent || typeof agent.id !== 'string')) refuse('Release runner ownership is unavailable or active');
        const { runnerEntryShieldsRunningRecord } = await import('../lib/runnerAgentLiveness.js');
        const live = await Promise.all(running.map(agent => runnerEntryShieldsRunningRecord(agent)));
        running.forEach((agent, index) => { if (live[index]) active.add(agent.id); });
      }
      if ([...active].some(id => !agents.some(agent => agent.id === id))) refuse('Agent ownership is unavailable');
      for (const agent of agents) {
        const ownsCheckpoint = agent.id === entry.owner.agentId || agent.taskId === entry.owner.taskId || agent.taskId === entry.task.id;
        if (agent.status === 'completed' && !active.has(agent.id)) continue;
        if (ownsCheckpoint) refuse('A release or synchronization is still active');
        let type = currentTaskTypeName(agent.metadata?.taskAnalysisType || agent.metadata?.analysisType || agent.metadata?.selfImprovementType);
        if (!type) {
          const { getTaskById } = await import('./cosTaskStore.js');
          const task = agent.taskId && await getTaskById(agent.taskId);
          if (!task) refuse('Active agent type is unavailable');
          type = currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType);
          if (!type && task.taskType !== 'user') refuse('Active agent type is unavailable');
        }
        if (type !== 'do-release' && type !== 'release-sync') continue;
        const workspace = agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
        const ownerRepo = workspace && await realpath(workspace).catch(() => null);
        if (!ownerRepo || samePath(ownerRepo, repo)) refuse('A release or synchronization is still active');
        const { execGit } = await import('../lib/execGit.js');
        const common = async path => {
          const result = await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], path, { ignoreExitCode: true }).catch(() => null);
          return result?.exitCode === 0 ? realpath(result.stdout.trim()).catch(() => null) : null;
        };
        const [originalCommon, activeCommon] = await Promise.all([common(repo), common(ownerRepo)]);
        if (!originalCommon || !activeCommon || samePath(originalCommon, activeCommon)) refuse('A release or synchronization is still active');
      }
      if (checkouts.length) {
        const { getBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');
        const inventory = await getBranchReconcileOutcome(entry.task.metadata.app);
        if (!checkouts.every(checkout => inventory?.remaining?.some(row => ['path', 'branch', 'head', 'checkoutIdentity']
          .every(key => row[key] === checkout[key])))) refuse('Selected checkout is not in the current inventory');
        const current = await Promise.all(checkouts.map(checkout => isCurrentRetirementCheckout(checkout).catch(() => false)));
        if (current.some(value => !value)) refuse('Selected checkout changed since the inventory');
      }
      entry.operatorReset = releaseSynchronizationResetSchema.parse({ version: 1, identity, resetAt: new Date().toISOString(), actor, reason, checkouts,
        previousStatus: synchronization?.status || 'pending', previousBlocker: synchronization?.blocker || entry.blocker || null });
      await saveReleaseSynchronization(entry);
      const saved = (await readOutbox()).publications[identity];
      if (!isDeepStrictEqual(saved?.operatorReset, entry.operatorReset)) refuse('Operator reset was not retained');
      await parkRetiredContinuation(saved);
      return saved.operatorReset;
    });
  });
}

async function parkRetiredContinuation(entry) {
  const { getTaskById, updateTask } = await import('./cosTaskStore.js');
  const task = await getTaskById(entry.task.id);
  if (!task || task.status !== 'pending') return;
  const result = await updateTask(task.id, { status: 'blocked', metadata: {
    blockedReason: 'Release synchronization retired by an operator', blockedCategory: 'release-synchronization-reset',
  } }, task.taskType || 'internal', { expectedStatus: 'pending', suppressDequeue: true });
  if (!result || result.error || (result.statusChanged
    ? !['blocked', 'completed'].includes(result.task?.status) : result.status !== 'blocked')) {
    refuse('Retired checkpoint was recorded but its continuation could not be parked');
  }
}

/** Agent archives remain verifier input until the corresponding durable outbox
 * has verified every obligation. This is retention evidence, not cleanup or
 * merge authority. Read without the task-publication queue: callers hold the
 * agent-state lock, which task registration may itself need. */
export async function readReleaseSynchronizationRetention() {
  const outbox = await readOutbox();
  return Object.values(outbox.publications).map(entry => ({
    version: entry.version, identity: entry.identity, owner: entry.owner, taskId: entry.task.id,
    verified: effectiveReleaseSynchronization(entry)?.status === 'verified',
  }));
}

// Never copy arbitrary agent/task metadata (credentials, old prompts, claims or
// retry budgets). Review settings are the original delivery obligations.
function synchronizationPrompt(publication) {
  return `Continue the verified release's development synchronization only. Publication is already verified; do not release again.
Use this task's provisioned isolated worktree and normal PR delivery lifecycle. Merge the exact published promotion commit into this synchronization branch, preserve newer development work, and deliver its PR against development through the configured review/CI/admission workflow. Do not edit the running application's checkout or adopt the publisher's checkout. After an interruption, ordinary delivery recovery retains this task's branch/PR; do not mint another synchronization task.
Read AGENTS.md and docs/VERSIONING.md, especially synchronization after publication. Use the normal delivery/recovery workflow, local review lifecycle, required exact-head hosted reviews and CI, combined-tree guards and repository merge admission. Do not enable deferred forge auto-merge or create a second merger.
The immutable publication evidence is:\n${JSON.stringify(publication, null, 2)}
Carry all candidate-only fixes and the published promotion ancestry into a normal synchronization PR against development. Resume the same PR/head after interruption; refuse another live owner and retain exact checkout identities. Never mutate the published tag/tree or merge later development into the release.
Run the required development quality snapshot without advancing the published release. Track its result separately from the synchronization PR. Preserve all configured reviewer obligations and budgets. Process settlement and receipt-verified API-only checkout retirement remain required; never take or delete the publisher's retained checkout.
Record exact synchronization PR/head, quality snapshot and retained checkout evidence through ordinary task delivery/recovery. A successful process or terminal summary does not verify synchronization. Report unresolved obligations explicitly; do not replace or erase the original publication receipt.`;
}

async function newEntry(agent, publication) {
  const { getTaskById } = await import('./cosTaskStore.js');
  const { getInstanceId, UNKNOWN_INSTANCE_ID } = await import('./instanceIdentity.js');
  const { getCodeReviewDefaults, resolveReviewLoopOptions } = await import('./codeReview.js');
  const { getAppById } = await import('./apps.js');
  const [source, instanceId] = await Promise.all([getTaskById(agent.taskId), getInstanceId()]);
  if (!source || !instanceId || instanceId === UNKNOWN_INSTANCE_ID) refuse('Release synchronization requires its original task and local instance');
  const policy = Object.fromEntries(RELEASE_SYNC_POLICY_KEYS.filter(key => source.metadata?.[key] !== undefined).map(key => [key, source.metadata[key]]));
  if (!policy.app) refuse('Release synchronization requires the original target app');
  policy.prCompletion = explicitPrCompletion(source);
  if (policy.prCompletion === null) {
    const app = await getAppById(policy.app);
    if (!app) refuse('Release synchronization requires its managed app policy');
    policy.prCompletion = resolveAppPrCompletion(app, source.metadata);
  }
  // Resolve standing settings now; a later settings edit cannot silently shed
  // the reviewers this publication's synchronization was required to satisfy.
  await getCodeReviewDefaults();
  const reviews = await resolveReviewLoopOptions(source.metadata);
  const owner = ownerSchema.parse({ agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt,
    workspace: agent.metadata.sourceWorkspace || agent.metadata.workspacePath });
  // Seeds are physical identities, not authority to adopt a branch by name. The
  // generic completion/retirement owner retains them and captures final heads.
  const checkouts = structuredClone(agent.metadata.checkoutSeeds || []);
  const inline = publication.synchronizationHandoffVersion === 2;
  const id = inline ? source.id : `task-release-sync-${publication.identity}`;
  const sourceType = source.taskType || 'internal';
  const entry = entrySchema.parse({ version: inline ? 2 : 1, identity: publication.identity, owner, publication,
    checkouts, registeredAt: null, attempts: 0, lastAttemptAt: null, blocker: null, retryAt: null,
    obligations: Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(key => [key, { status: 'pending' }])),
    task: { id, ...(inline && { taskType: sourceType }), description: `Synchronize verified release ${publication.tag} (${publication.repository})`,
      status: 'pending', priority: source.priority || 'MEDIUM', autoApproved: true, approvalRequired: false,
      metadata: { ...policy, ...reviews, analysisType: inline ? 'do-release' : 'release-sync', targetInstanceId: instanceId,
        useWorktree: true, openPR: true, worktreeChangesExpected: true,
        releaseSynchronization: { version: inline ? 2 : 1, identity: publication.identity,
          publisherAgentId: owner.agentId, publisherTaskId: owner.taskId, publisherStartedAt: owner.startedAt },
        prompt: synchronizationPrompt(publication) } },
  });
  // Task scalar metadata uses the legacy string representation. Freeze the
  // stored form so readback and retry compare the actual persistence contract.
  entry.task = storedForm(entry.task, inline ? sourceType : 'internal');
  if (inline) entry.task = { ...entry.task, id: source.id, taskType: sourceType };
  return entry;
}

async function registerEntry(entry) {
  const { addTask, getTaskById } = await import('./cosTaskStore.js');
  if (!hasFrozenPrDisposition(entry.task.metadata)) {
    throw new ServerError('Release synchronization review policy was not captured; retain the original task and recover from historical delivery evidence (docs/VERSIONING.md)',
      { status: 409, code: 'RELEASE_SYNC_REVIEW_POLICY_UNVERIFIED' });
  }
  const key = createHash('sha256').update(JSON.stringify([entry.identity, entry.owner])).digest('hex');
  entry.attempts++;
  entry.lastAttemptAt = new Date().toISOString();
  await saveReleaseSynchronization(entry);
  if (isInlineReleaseSynchronization(entry)) {
    const source = await getTaskById(entry.owner.taskId);
    if (!source || source.id !== entry.task.id || (source.taskType || 'internal') !== entry.task.taskType
      || source.metadata?.app !== entry.task.metadata.app) refuse('Release synchronization task has a conflicting owner');
    entry.registeredAt ||= new Date().toISOString();
    entry.blocker = null;
    entry.retryAt = null;
    await saveReleaseSynchronization(entry);
    const policy = Object.fromEntries(RELEASE_SYNC_POLICY_KEYS.filter(key => entry.task.metadata[key] !== undefined)
      .map(key => [key, entry.task.metadata[key]]));
    return { taskId: source.id, registeredAt: entry.registeredAt, policy,
      synchronizationVerified: effectiveReleaseSynchronization(entry)?.status === 'verified' };
  }
  // A completed historical task is still the owner. Never regenerate it, even
  // when it has left the task working set or execution reported success.
  const existing = await getTaskById(entry.task.id);
  if (!existing && entry.registeredAt) refuse('Registered release synchronization task is missing; retain its outbox');
  if (!existing) await addTask(entry.task, 'internal', { raw: true, idempotencyKey: key });
  const saved = await getTaskById(entry.task.id);
  const expectedMetadata = { ...entry.task.metadata, idempotencyKey: key };
  if (!saved || saved.taskType !== 'internal' || RELEASE_SYNC_FROZEN_METADATA_KEYS
    .some(field => !isDeepStrictEqual(saved.metadata?.[field], expectedMetadata[field]))) {
    refuse('Release synchronization task has a conflicting owner');
  }
  entry.registeredAt ||= new Date().toISOString();
  entry.blocker = null;
  entry.retryAt = null;
  await saveReleaseSynchronization(entry);
  return { taskId: saved.id, registeredAt: entry.registeredAt, synchronizationVerified: effectiveReleaseSynchronization(entry)?.status === 'verified' };
}

async function retainFailure(entry, error) {
  entry.blocker = error.code || 'release-sync-registration-failed';
  entry.retryAt = new Date(Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(entry.attempts, 5))).toISOString();
  await saveReleaseSynchronization(entry);
}

/** Called after the protected receipt write, and before EVERY terminal agent
 * write. A refusal leaves execution/receipt/checkouts available for recovery.
 */
export function ensureReleaseSynchronization(agent) {
  return queue(async () => {
    const publication = agent?.metadata?.releasePublication;
    if (publication?.status !== 'verified' || ![1, 2].includes(publication.synchronizationHandoffVersion)) refuse('Release synchronization requires an enrolled verified publication');
    identitySchema.parse(publication.identity);
    const outbox = await readOutbox();
    let entry = outbox.publications[publication.identity];
    if (entry) {
      const owner = { agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt,
        workspace: agent.metadata.sourceWorkspace || agent.metadata.workspacePath };
      if (!(isInlineReleaseSynchronization(entry) ? isInlineReleaseOwner(entry, agent) : isDeepStrictEqual(entry.owner, owner))
        || !isDeepStrictEqual(entry.publication, publication)) refuse('Publication synchronization is owned by another coordinator');
      if (releaseSynchronizationReset(entry)) return { taskId: entry.task.id, registeredAt: entry.registeredAt, synchronizationVerified: false, retired: true };
    } else {
      entry = await newEntry(agent, publication);
      outbox.publications[publication.identity] = entry;
      // Intent precedes queue publication. A crash after either write retries
      // this exact immutable payload, not a newly computed prompt or policy.
      await saveReleaseSynchronization(entry);
    }
    return registerEntry(entry).catch(async error => {
      await retainFailure(entry, error);
      throw error;
    });
  });
}

/** Recovery has no LLM call and never discovers branches or resets budgets.
 * It registers only continuations authorized by an existing verified receipt.
 */
export async function recoverReleaseSynchronizationHandoffs(agents) {
  const initial = await readOutbox();
  const attempted = new Set();
  for (const agent of agents.filter(value => value.metadata?.releasePublication?.status === 'verified'
    && [1, 2].includes(value.metadata.releasePublication.synchronizationHandoffVersion))) {
    const identity = agent.metadata.releasePublication.identity;
    const previous = initial.publications[identity];
    if (releaseSynchronizationReset(previous) || previous?.registeredAt || (previous?.retryAt && Date.parse(previous.retryAt) > Date.now()) || attempted.has(identity)) continue;
    attempted.add(identity);
    await ensureReleaseSynchronization(agent).catch(error => {
      console.log(`🚫 Release synchronization handoff retained for ${agent.id}: ${error.code || 'registration-unavailable'}`);
    });
  }
  const due = await queue(async () => {
    const outbox = await readOutbox();
    for (const entry of Object.values(outbox.publications).filter(releaseSynchronizationReset)) {
      await parkRetiredContinuation(entry).catch(() => console.log(`🚫 Retired release continuation still needs parking: ${entry.task.id}`));
    }
    for (const entry of Object.values(outbox.publications).filter(value => !releaseSynchronizationReset(value) && !value.registeredAt && !attempted.has(value.identity)
      && (!value.retryAt || Date.parse(value.retryAt) <= Date.now()))) {
      await registerEntry(entry).catch(async error => {
        await retainFailure(entry, error);
      });
    }
    return Object.values(outbox.publications).filter(entry => entry.registeredAt && !releaseSynchronizationReset(entry)
      && effectiveReleaseSynchronization(entry)?.status !== 'verified'
      && !(entry.synchronization?.delivery && !isInlineReleaseSynchronization(entry))
      && (!effectiveReleaseSynchronization(entry)?.retryAt || Date.parse(effectiveReleaseSynchronization(entry).retryAt) <= Date.now()))
      .sort((left, right) => (left.synchronization?.checkedAt || '').localeCompare(right.synchronization?.checkedAt || ''))
      .slice(0, 3).map(entry => entry.task.id);
  });
  for (const taskId of due) {
    await verifyReleaseSynchronizationTask(taskId, { agents, respectRetryAt: true });
    // Retirement calls back into this service to preserve the exact review.
    // Run it outside the outbox queue and let its normal fences recheck every
    // owner and physical generation at the destructive boundary.
    const entry = Object.values((await readOutbox()).publications).find(value => value.task.id === taskId);
    if (isInlineReleaseSynchronization(entry)) {
      const { settleInlineReleaseCheckouts } = await import('./releaseSynchronizationCleanup.js');
      const result = await settleInlineReleaseCheckouts(entry).catch(error => {
        console.log(`🚫 Release checkout retirement retained for ${taskId}: ${error.code || 'retirement-unavailable'}`);
        return null;
      });
      if (result?.retired?.length) await verifyReleaseSynchronizationTask(taskId, { agents });
    }
  }
}

async function verifyEntry(entry, agents) {
  const result = !publisherCandidateTarget(entry)
    ? { status: 'blocked', blocker: 'publisher-candidate-checkout-unverified', obligations: entry.obligations }
    : agents.some(agent => agent.taskId === entry.task.id)
      ? await (await import('./releaseSynchronizationEvidence.js')).inspectReleaseSynchronization(entry, agents)
      : { status: 'pending', blocker: 'continuation-not-started', obligations: entry.obligations };
  const attempts = (entry.synchronization?.attempts || 0) + 1;
  const checkedAt = new Date().toISOString();
  entry.obligations = result.obligations;
  entry.synchronization = { ...(entry.synchronization?.delivery && { delivery: entry.synchronization.delivery }), status: result.status, attempts, checkedAt,
    blocker: result.blocker, verifiedAt: result.status === 'verified' ? checkedAt : null,
    retryAt: result.status === 'verified' ? null : new Date(Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5))).toISOString() };
  // Receipt persistence precedes change events and checkout retirement.
  await saveReleaseSynchronization(entry);
  await emitReleaseSynchronization(entry, agents);
  return entry.synchronization;
}

async function emitReleaseSynchronization(entry, agents, { suppressCompletionWake = false } = {}) {
  const { projectTaskReleaseMilestones, projectAgentReleaseMilestones } = await import('./releaseSynchronizationProjection.js');
  const { getTaskById } = await import('./cosTaskStore.js');

  const continuationTask = await getTaskById(entry.task.id).catch(() => null);
  const projectedContinuation = continuationTask ? projectTaskReleaseMilestones(continuationTask, entry) : null;
  const suppress = suppressCompletionWake ? { suppressCompletionWake: true, suppressDequeue: true } : {};
  cosEvents.emit('tasks:changed', { action: 'release-synchronization', taskId: entry.task.id, task: projectedContinuation, ...suppress });

  if (entry.owner.taskId && entry.owner.taskId !== entry.task.id) {
    const publisherTask = await getTaskById(entry.owner.taskId).catch(() => null);
    if (publisherTask) {
      cosEvents.emit('tasks:changed', { action: 'release-synchronization-parent', taskId: entry.owner.taskId, task: projectTaskReleaseMilestones(publisherTask, entry), ...suppress });
    }
  }

  const publisherAgent = agents.find(a => a.id === entry.owner.agentId);
  if (publisherAgent) {
    cosEvents.emit('agent:updated', projectAgentReleaseMilestones(publisherAgent, entry));
  }
  for (const agent of agents.filter(a => a.taskId === entry.task.id)) {
    cosEvents.emit('agent:updated', projectAgentReleaseMilestones(agent, entry));
  }
  cosEvents.emit('agents:changed');
}

/** Inspect one continuation independently of its execution verdict. Only this task's enrolled outbox can authorize inspection.
 */
export function verifyReleaseSynchronizationTask(taskId, { agents = null, respectRetryAt = false } = {}) {
  return queue(async () => {
    const outbox = await readOutbox();
    const entry = Object.values(outbox.publications).find(value => value.task.id === taskId && value.registeredAt);
    if (!entry || releaseSynchronizationReset(entry) || effectiveReleaseSynchronization(entry)?.status === 'verified'
      || (entry.synchronization?.delivery && !isInlineReleaseSynchronization(entry))) return effectiveReleaseSynchronization(entry) || null;
    if (respectRetryAt && effectiveReleaseSynchronization(entry)?.retryAt && Date.parse(effectiveReleaseSynchronization(entry).retryAt) > Date.now()) return effectiveReleaseSynchronization(entry);
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    return verifyEntry(entry, agents || await readBranchCompletionPolicies({ repairIndex: false }));
  });
}

/** A release may finish execution only after delivery and quality are observed.
 * Process settlement and checkout retirement necessarily follow process exit.
 */
export async function verifyInlineReleaseDelivery(agent) {
  const publication = agent?.metadata?.releasePublication;
  if (publication?.synchronizationHandoffVersion !== 2) return null;
  const inspection = await verifyReleaseSynchronizationTask(agent.taskId).catch(() => null);
  const entry = (await readOutbox().catch(() => null))?.publications?.[publication.identity];
  if (!entry || !entry.registeredAt || !isInlineReleaseOwner(entry, agent)) {
    return { verified: false, reason: 'release synchronization ownership is unavailable' };
  }
  // A failed context read can leave earlier per-obligation receipts intact.
  // They do not prove the current PR still has the reviewed head.
  if (!inspection || (inspection.blocker && !/^(?:processSettlement|retirement):/.test(inspection.blocker))) {
    return { verified: false, reason: inspection?.blocker || 'release synchronization evidence is unavailable' };
  }
  const required = RELEASE_SYNC_OBLIGATIONS.filter(name => !['processSettlement', 'retirement'].includes(name));
  const missing = required.find(name => entry.obligations[name]?.status !== 'verified');
  return missing ? { verified: false, reason: `${missing}: ${entry.obligations[missing]?.blocker || 'not verified'}` }
    : { verified: true };
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Retirement runs this outside its ownership fence. The ordinary retirement
 * transaction still rechecks the exact generation and all removal authority.
 */
export function retainReleaseSynchronizationReview(release) {
  return queue(async () => {
    const outbox = await readOutbox();
    const entries = Object.values(outbox.publications).filter(entry => entry.registeredAt && effectiveReleaseSynchronization(entry)?.status !== 'verified');
    if (!entries.length) return true;
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    const agents = await readBranchCompletionPolicies({ repairIndex: false });
    for (const entry of entries) {
      if (releaseSynchronizationReset(entry) || resetReleasesCheckout(entry, release)) continue;
      const owns = agents.some(agent => (agent.taskId === entry.task.id
        || (agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt)) && agent.metadata?.checkoutSeeds?.some(seed =>
        seed.branch === release.branch && seed.path === release.path
        && retirementCheckoutIdentityFromPointer(seed.incarnation?.pointer) === release.checkoutIdentity));
      if (!owns) continue;
      if (!(entry.synchronization?.delivery && !isInlineReleaseSynchronization(entry))) await verifyEntry(entry, agents);
      const review = entry.obligations.localReview;
      const retained = entry.obligations.retirement.evidence;
      if (review.status !== 'verified' || review.evidence?.prUrl !== retained?.prUrl
        || !retained?.checkouts?.some(row => row.branch === release.branch && row.path === release.path
          && row.head === release.head && row.checkoutIdentity === release.checkoutIdentity)) return false;
      const publisherSeed = publisherCandidateSeed(entry);
      if (publisherSeed && publisherSeed.branch === release.branch && publisherSeed.path === release.path
        && retirementCheckoutIdentityFromPointer(publisherSeed.incarnation.pointer) === release.checkoutIdentity) {
        // Capture private worktree review metadata while the exact publisher
        // generation still exists. An absent optional review is recorded as
        // absent; a mismatched or unreadable receipt never becomes a verdict.
        const prUrl = `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`;
        const { localReviewLifecycle } = await import('../lib/localReviewLifecycle.js');
        const { localReviewAttributionLabels } = await import('../lib/localReviewAttribution.js');
        const lifecycle = await localReviewLifecycle(release.path, { base: 'release', prUrl });
        if ((!lifecycle.reusable && !lifecycle.legacyPublished) || lifecycle.receipt?.status === 'review-blocked') return false;
        const models = await localReviewAttributionLabels(release.path);
        entry.obligations.retirement.evidence = { ...retained, publisherReview: {
          branch: release.branch, path: release.path, head: release.head, checkoutIdentity: release.checkoutIdentity,
          prUrl, receipt: lifecycle.receipt || null, models,
        } };
        await saveReleaseSynchronization(entry);
      }
    }
    return true;
  });
}

/** Locked initialized retirement is limited to an exact, settled publisher.
 * Cached settlement is not authority at the destructive boundary. */
export async function validateLockedPublisherRetirement(release) {
  if (!release.checkoutIdentity || !release.locked) return false;
  const outbox = await readOutbox();
  const entries = Object.values(outbox.publications).filter(entry => {
    const target = publisherCandidateTarget(entry);
    return entry.registeredAt && target && target.repoPath === release.repoPath
      && target.path === release.path && target.branch === release.branch
      && target.head === release.head && target.checkoutIdentity === release.checkoutIdentity;
  });
  if (entries.length !== 1) return false;
  const entry = entries[0], target = publisherCandidateTarget(entry);
  const evidence = entry.obligations.retirement.evidence;
  if (entry.obligations.localReview.status !== 'verified' || entry.obligations.processSettlement.status !== 'verified'
    || !evidence?.checkouts?.some(row => isInlineReleaseSynchronization(entry)
      ? ['repoPath', 'path', 'branch', 'head', 'checkoutIdentity'].every(key => row[key] === target[key])
      : isDeepStrictEqual(row, target))) return false;
  const review = evidence.publisherReview;
  if (!review || review.path !== target.path || review.branch !== target.branch
    || review.head !== target.head || review.checkoutIdentity !== target.checkoutIdentity
    || review.prUrl !== `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`
    || !Array.isArray(review.models)) return false;
  const [{ readBranchCompletionPolicies }, { publisherProcessesSettled }] = await Promise.all([
    import('./branchCompletionPolicy.js'), import('./releaseProcessSettlement.js'),
  ]);
  const agents = await readBranchCompletionPolicies({ repairIndex: false });
  return publisherProcessesSettled(entry, agents, release.path);
}
