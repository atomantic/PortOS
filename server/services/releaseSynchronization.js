/** Machine-local publication outbox. It owns work, never merge or deletion authority.
 * Keep immutable dispatches after completion: queue history retention is not an
 * idempotency boundary, and a failed run does not unpublish a release.
 */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isCurrentRetirementCheckout, retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { checkoutSeedSchema } from '../lib/checkoutSeed.js';
import { z } from 'zod';
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { RELEASE_SYNC_POLICY_KEYS, RELEASE_SYNC_FROZEN_METADATA_KEYS, RELEASE_SYNC_OBLIGATIONS,
  effectiveReleaseSynchronization, publisherCandidateSeed, publisherCandidateTarget, legacyPublisherRecovery,
  releaseSynchronizationReset, releaseSynchronizationResetSchema, resetReleasesCheckout } from '../lib/releaseSynchronization.js';
import { currentTaskTypeName } from '../lib/taskTypeRenames.js';
import { storedForm } from '../lib/cosTaskRows.js';
import { cosEvents } from './cosEvents.js';

const queue = createFileWriteQueue();
const identitySchema = z.string().regex(/^[a-f0-9]{64}$/);
const ownerSchema = z.object({ agentId: z.string().min(1), taskId: z.string().min(1), startedAt: z.string().datetime(), workspace: z.string().min(1) }).strict();
const obligationSchema = z.object({ status: z.enum(['pending', 'blocked', 'verified']),
  verifiedAt: z.string().datetime().optional(), blocker: z.string().optional(), evidence: z.record(z.string(), z.unknown()).optional() }).strict()
  .refine(value => value.status !== 'verified' || (value.verifiedAt && value.evidence && Object.keys(value.evidence).length > 0));
const entrySchema = z.object({
  version: z.literal(1), identity: identitySchema, owner: ownerSchema,
  publication: z.object({ identity: identitySchema, status: z.literal('verified') }).passthrough(),
  task: z.object({ id: z.string(), metadata: z.object({ releaseSynchronization: z.object({ identity: identitySchema }).passthrough() }).passthrough() }).passthrough(),
  obligations: z.object(Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(key => [key, obligationSchema]))).strict(),
  synchronization: z.object({ status: z.enum(['pending', 'running', 'blocked', 'verified']),
    attempts: z.number().int().nonnegative(), checkedAt: z.string().datetime(), retryAt: z.string().datetime().nullable(),
    verifiedAt: z.string().datetime().nullable(), blocker: z.string().nullable() }).strict().optional(),
  legacyRecovery: z.record(z.string(), z.unknown()).optional(),
  operatorReset: releaseSynchronizationResetSchema.optional(),
  checkouts: z.array(z.unknown()), registeredAt: z.string().datetime().nullable(),
  attempts: z.number().int().nonnegative(), lastAttemptAt: z.string().datetime().nullable(),
  blocker: z.string().nullable(), retryAt: z.string().datetime().nullable(),
}).strict();
const outboxSchema = z.object({ version: z.literal(1), publications: z.record(identitySchema, entrySchema) }).strict();
const refuse = message => { throw new ServerError(message, { status: 409, code: 'RELEASE_SYNC_HANDOFF_UNVERIFIED' }); };

async function readOutbox() {
  const value = await readReleaseSynchronizationOutbox();
  const parsed = outboxSchema.safeParse(value);
  if (!parsed.success || Object.entries(parsed.data.publications).some(([key, entry]) => key !== entry.identity
    || entry.publication.identity !== key || entry.task.id !== `task-release-sync-${key}`
    || entry.task.metadata.releaseSynchronization.identity !== key
    || (entry.synchronization?.status === 'verified' && RELEASE_SYNC_OBLIGATIONS.some(name => entry.obligations[name].status !== 'verified')))) refuse('Release synchronization outbox is unreadable');
  return parsed.data;
}

/** Continuations belong to an already authorized publication, not the schedule
 * that generates new releases. Keep the existing immutable task binding, and
 * serialize a subsequent release behind unfinished synchronization for its app.
 */
export async function releaseTaskDispatchDisposition(task) {
  const type = currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType);
  if (!['release-sync', 'do-release'].includes(type)) return null;
  const outbox = await readOutbox();
  if (type === 'do-release') {
    return Object.values(outbox.publications).some(entry => entry.task.metadata.app === task.metadata?.app
      && !releaseSynchronizationReset(entry) && effectiveReleaseSynchronization(entry)?.status !== 'verified') ? 'wait-for-synchronization' : null;
  }
  const entry = outbox.publications[task.metadata?.releaseSynchronization?.identity];
  if (!entry || task.id !== entry.task.id) return null;
  if (releaseSynchronizationReset(entry)) return 'retired-continuation';
  if (!entry.registeredAt) return null;
  const expected = { ...entry.task.metadata,
    idempotencyKey: createHash('sha256').update(JSON.stringify([entry.identity, entry.owner])).digest('hex') };
  return RELEASE_SYNC_FROZEN_METADATA_KEYS.every(key => isDeepStrictEqual(task.metadata?.[key], expected[key]))
    ? 'registered-continuation' : null;
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
  } }, 'internal', { expectedStatus: 'pending', suppressDequeue: true });
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
    identity: entry.identity, owner: entry.owner, taskId: entry.task.id,
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
  const [source, instanceId] = await Promise.all([getTaskById(agent.taskId), getInstanceId()]);
  if (!source || !instanceId || instanceId === UNKNOWN_INSTANCE_ID) refuse('Release synchronization requires its original task and local instance');
  const policy = Object.fromEntries(RELEASE_SYNC_POLICY_KEYS.filter(key => source.metadata?.[key] !== undefined).map(key => [key, source.metadata[key]]));
  if (!policy.app) refuse('Release synchronization requires the original target app');
  // Resolve standing settings now; a later settings edit cannot silently shed
  // the reviewers this publication's synchronization was required to satisfy.
  await getCodeReviewDefaults();
  const reviews = await resolveReviewLoopOptions(source.metadata);
  const owner = ownerSchema.parse({ agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt,
    workspace: agent.metadata.sourceWorkspace || agent.metadata.workspacePath });
  // Seeds are physical identities, not authority to adopt a branch by name. The
  // generic completion/retirement owner retains them and captures final heads.
  const checkouts = structuredClone(agent.metadata.checkoutSeeds || []);
  const id = `task-release-sync-${publication.identity}`;
  const entry = entrySchema.parse({ version: 1, identity: publication.identity, owner, publication,
    checkouts, registeredAt: null, attempts: 0, lastAttemptAt: null, blocker: null, retryAt: null,
    obligations: Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(key => [key, { status: 'pending' }])),
    task: { id, description: `Synchronize verified release ${publication.tag} (${publication.repository})`,
      status: 'pending', priority: source.priority || 'MEDIUM', autoApproved: true, approvalRequired: false,
      metadata: { ...policy, ...reviews, analysisType: 'release-sync', targetInstanceId: instanceId,
        useWorktree: true, openPR: true, worktreeChangesExpected: true,
        releaseSynchronization: { version: 1, identity: publication.identity,
          publisherAgentId: owner.agentId, publisherTaskId: owner.taskId, publisherStartedAt: owner.startedAt },
        prompt: synchronizationPrompt(publication) } },
  });
  // Task scalar metadata uses the legacy string representation. Freeze the
  // stored form so readback and retry compare the actual persistence contract.
  entry.task = storedForm(entry.task, 'internal');
  return entry;
}

async function registerEntry(entry) {
  const { addTask, getTaskById } = await import('./cosTaskStore.js');
  const key = createHash('sha256').update(JSON.stringify([entry.identity, entry.owner])).digest('hex');
  entry.attempts++;
  entry.lastAttemptAt = new Date().toISOString();
  await saveReleaseSynchronization(entry);
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
    if (publication?.status !== 'verified' || publication.synchronizationHandoffVersion !== 1) refuse('Release synchronization requires an enrolled verified publication');
    identitySchema.parse(publication.identity);
    const outbox = await readOutbox();
    let entry = outbox.publications[publication.identity];
    if (entry) {
      const owner = { agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt,
        workspace: agent.metadata.sourceWorkspace || agent.metadata.workspacePath };
      if (!isDeepStrictEqual(entry.owner, owner) || !isDeepStrictEqual(entry.publication, publication)) refuse('Publication synchronization is owned by another coordinator');
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
    && value.metadata.releasePublication.synchronizationHandoffVersion === 1)) {
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
      && (!effectiveReleaseSynchronization(entry)?.retryAt || Date.parse(effectiveReleaseSynchronization(entry).retryAt) <= Date.now()))
      .sort((left, right) => (left.synchronization?.checkedAt || '').localeCompare(right.synchronization?.checkedAt || ''))
      .slice(0, 3).map(entry => entry.task.id);
  });
  for (const taskId of due) await verifyReleaseSynchronizationTask(taskId, { agents, respectRetryAt: true });
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
  entry.synchronization = { status: result.status, attempts, checkedAt,
    blocker: result.blocker, verifiedAt: result.status === 'verified' ? checkedAt : null,
    retryAt: result.status === 'verified' ? null : new Date(Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5))).toISOString() };
  // Receipt persistence precedes change events and checkout retirement.
  await saveReleaseSynchronization(entry);
  await emitReleaseSynchronization(entry, agents);
  return entry.synchronization;
}

async function emitReleaseSynchronization(entry, agents) {
  const { projectTaskReleaseMilestones, projectAgentReleaseMilestones } = await import('./releaseSynchronizationProjection.js');
  const { getTaskById } = await import('./cosTaskStore.js');

  const continuationTask = await getTaskById(entry.task.id).catch(() => null);
  const projectedContinuation = continuationTask ? projectTaskReleaseMilestones(continuationTask, entry) : null;
  cosEvents.emit('tasks:changed', { action: 'release-synchronization', taskId: entry.task.id, task: projectedContinuation });

  if (entry.owner.taskId && entry.owner.taskId !== entry.task.id) {
    const publisherTask = await getTaskById(entry.owner.taskId).catch(() => null);
    if (publisherTask) {
      cosEvents.emit('tasks:changed', { action: 'release-synchronization-parent', taskId: entry.owner.taskId, task: projectTaskReleaseMilestones(publisherTask, entry) });
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
    if (!entry || releaseSynchronizationReset(entry) || effectiveReleaseSynchronization(entry)?.status === 'verified') return effectiveReleaseSynchronization(entry) || null;
    if (respectRetryAt && effectiveReleaseSynchronization(entry)?.retryAt && Date.parse(effectiveReleaseSynchronization(entry).retryAt) > Date.now()) return effectiveReleaseSynchronization(entry);
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    return verifyEntry(entry, agents || await readBranchCompletionPolicies({ repairIndex: false }));
  });
}

/** A fresh exact promotion PR identifies the remote candidate. A different
 * local branch alone does not identify a different physical checkout. */
async function legacyPromotionBranch(entry, repoPath) {
  if (entry.publication.candidateBranch) return entry.publication.candidateBranch;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.publication.repository || '')
    || !Number.isSafeInteger(entry.publication.promotionPrNumber) || entry.publication.promotionPrNumber < 1) return null;
  const [{ execGh }, { resolveForgeExecOptions }] = await Promise.all([import('./github.js'), import('./forgeExecOptions.js')]);
  const options = await resolveForgeExecOptions(repoPath);
  const pr = JSON.parse(await execGh(['api', '--hostname', 'github.com',
    `repos/${entry.publication.repository}/pulls/${entry.publication.promotionPrNumber}`], undefined, options));
  if (pr.number !== entry.publication.promotionPrNumber || pr.merged !== true
    || pr.head?.sha !== entry.publication.candidateHead || pr.head?.repo?.full_name !== entry.publication.repository
    || pr.base?.ref !== 'release' || pr.base?.repo?.full_name !== entry.publication.repository
    || pr.merge_commit_sha !== entry.publication.promotionMerge || typeof pr.head?.ref !== 'string' || !pr.head.ref) return null;
  return pr.head.ref;
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** The missing publisher seed cannot be reconstructed from a branch name.
 * An independently seeded, completed checkout whose entire physical generation
 * was created after publication cannot be the original publisher checkout.
 * Recheck the physical binding as well as the server-owned records. */
async function independentLegacyCheckout(entry, release, agents) {
  const published = Date.parse(entry.publication.publishedAt);
  if (!Number.isFinite(published) || !release.repoPath || !release.path || !release.branch || !release.head || !release.checkoutIdentity) return null;
  // Forge timestamps may have only second precision; require a full second of
  // separation and reject filesystem times later than the recorded seed.
  const afterPublication = (value, seeded) => typeof value === 'string' && /^\d+$/.test(value)
    && BigInt(value) > BigInt(published + 1000) * 1000000n
    && BigInt(value) < BigInt(seeded + 1) * 1000000n;
  const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
  const bindings = [];
  for (const agent of agents) {
    // Swarm coordinators and release publishers can run in the primary checkout
    // while the server records their separate, seeded child checkout.
    const publication = agent.metadata?.releasePublication;
    let coordinatorOwnsChild = agent.metadata?.isWorktree === false && samePath(agent.metadata.workspacePath, release.repoPath)
      && ((agent.metadata.configClaimFlow === true && [agent.metadata.claimBranches, agent.metadata.claimReleasedBranches]
        .some(branches => Array.isArray(branches) && branches.includes(release.branch)))
        || (agent.metadata.taskAnalysisType === 'do-release' && publication?.status === 'verified'
          && publication.candidateBranch === release.branch && publication.candidateHead === release.head));
    if (coordinatorOwnsChild) {
      const { getInstanceId, UNKNOWN_INSTANCE_ID } = await import('./instanceIdentity.js');
      const instance = await getInstanceId().catch(() => null);
      coordinatorOwnsChild = !!instance && instance !== UNKNOWN_INSTANCE_ID && agent.metadata.instanceId === instance;
    }
    if (agent.status !== 'completed' || agent.id === entry.owner.agentId || !agent.taskId || agent.taskId === entry.owner.taskId
      || !(Date.parse(agent.startedAt) > published) || !(Date.parse(agent.completedAt) >= Date.parse(agent.startedAt))
      || (!samePath(agent.metadata?.workspacePath, release.path) && !coordinatorOwnsChild)) continue;
    const seeds = (agent.metadata?.checkoutSeeds || []).filter(seed => checkoutSeedSchema.safeParse(seed).success
      && seed.agentId === agent.id && seed.startedAt === agent.startedAt
      && Date.parse(seed.seededAt) >= Date.parse(agent.startedAt) && Date.parse(seed.seededAt) <= Date.parse(agent.completedAt)
      && samePath(seed.repoPath, release.repoPath) && samePath(seed.path, release.path) && seed.branch === release.branch
      && retirementCheckoutIdentityFromPointer(seed.incarnation.pointer) === release.checkoutIdentity
      && [seed.checkout, seed.incarnation.pointer, seed.incarnation.gitdir].every(row => afterPublication(row.birthtimeNs, Date.parse(seed.seededAt))));
    for (const seed of seeds) {
      const receipts = (agent.metadata?.completedCheckouts || []).filter(receipt => completedCheckoutReceiptValid(agent, receipt)
        && samePath(receipt.repoPath, seed.repoPath) && samePath(receipt.path, seed.path) && receipt.branch === seed.branch
        && receipt.head === release.head && isDeepStrictEqual(receipt.incarnation, seed.incarnation));
      if (receipts.length === 1) bindings.push({ agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt,
        completedAt: agent.completedAt, seed, receipt: receipts[0] });
    }
  }
  if (bindings.length !== 1) return null;
  const binding = bindings[0], seed = binding.seed;
  const identity = async (path, directory) => {
    const stat = await lstat(path, { bigint: true });
    if (!(directory ? stat.isDirectory() : stat.isFile())) return null;
    return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
  };
  const gitdir = seed.incarnation.gitdir;
  const pointerText = await readFile(join(release.path, '.git'), 'utf8').catch(() => null);
  const pointerPath = /^gitdir: (.+)\s*$/i.exec(pointerText || '')?.[1]?.trim();
  const currentGitdir = pointerPath && await realpath(resolve(release.path, pointerPath)).catch(() => null);
  if (!currentGitdir || !samePath(currentGitdir, gitdir.path)) return null;
  const observed = await Promise.all([
    identity(release.path, true), identity(join(release.path, '.git'), false), identity(gitdir.path, true),
  ]).catch(() => []);
  if (!isDeepStrictEqual(observed, [seed.checkout, seed.incarnation.pointer,
    { dev: gitdir.dev, ino: gitdir.ino, birthtimeNs: gitdir.birthtimeNs }])) return null;
  return binding;
}

const exclusionKey = entry => `legacy-exclusion:${entry.identity}`;
const exclusionProof = (entry, release, candidate, binding) => ({
  publication: entry.publication, owner: entry.owner,
  release: { repoPath: release.repoPath, path: release.path, branch: release.branch, head: release.head, checkoutIdentity: release.checkoutIdentity },
  candidate, binding,
});

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
      // A branch name alone cannot exclude a locally aliased publisher checkout.
      const [releaseRepo, ownerRepo] = release.repoPath
        ? await Promise.all([realpath(release.repoPath).catch(() => null), realpath(entry.owner.workspace).catch(() => null)]) : [null, null];
      let sameRepository = !releaseRepo || !ownerRepo || samePath(releaseRepo, ownerRepo);
      if (sameRepository && releaseRepo && !entry.publication.candidateBranch && release.branch && !publisherCandidateSeed(entry)) {
        const binding = await independentLegacyCheckout(entry, release, agents);
        const candidate = binding && await legacyPromotionBranch(entry, releaseRepo).catch(() => null);
        if (candidate && candidate !== release.branch) sameRepository = false;
      }
      const target = publisherCandidateTarget(entry);
      if (sameRepository && !publisherCandidateSeed(entry)
        && target && target.branch === release.branch && target.path === release.path) {
        const legacy = legacyPublisherRecovery(entry);
        if (!legacy || legacy.evidence.mode !== 'present'
          || target.head !== release.head || target.checkoutIdentity !== release.checkoutIdentity) return false;
        await verifyEntry(entry, agents);
        if (entry.obligations.localReview.status !== 'verified' || entry.obligations.processSettlement.status !== 'verified'
          || !entry.obligations.retirement.evidence?.checkouts?.some(row => isDeepStrictEqual(row, target))) return false;
        continue;
      }
      const owns = agents.some(agent => (agent.taskId === entry.task.id
        || (agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt)) && agent.metadata?.checkoutSeeds?.some(seed =>
        seed.branch === release.branch && seed.path === release.path
        && retirementCheckoutIdentityFromPointer(seed.incarnation?.pointer) === release.checkoutIdentity));
      if (!owns) continue;
      await verifyEntry(entry, agents);
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

/** Explicit recovery binds the original capture and existing preservation.
 * The completed source run and publication stay immutable. */
export async function reviewLegacyReleaseRecovery(identity) {
  const outbox = await readOutbox();
  const entry = outbox.publications[identity];
  if (!entry?.registeredAt || publisherCandidateSeed(entry)) refuse('Legacy recovery requires a registered unseeded publication');
  const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
  const { inspectLegacyPublisher } = await import('./legacyReleaseRecovery.js');
  const proof = await inspectLegacyPublisher(entry, await readBranchCompletionPolicies({ repairIndex: false }));
  return { digest: proof.digest, prUrl: proof.evidence.prUrl, branch: proof.evidence.capture.branch,
    head: proof.evidence.capture.head, path: proof.evidence.capture.path, mode: proof.evidence.mode,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(proof.evidence.capture.incarnation.pointer),
    publisherAgentId: proof.evidence.owner.agentId, publisherTaskId: proof.evidence.owner.taskId,
    publisherStartedAt: proof.evidence.owner.startedAt, archiveDir: proof.evidence.archive.archiveDir,
    capturedAt: proof.evidence.capture.capturedAt, archiveDigest: proof.evidence.archive.evidenceDigest,
    archivedAt: proof.evidence.archive.archivedAt, lifecycleStatus: proof.evidence.review.status,
    lifecycleRecordedHead: proof.evidence.review.reviewedHead, candidateInspection: proof.evidence.candidateInspection, ...(proof.evidence.preservation && { lock: proof.evidence.preservation.lock }),
    ...(proof.retirement && { retiredAt: proof.retirement.retiredAt }) };
}

export function acceptLegacyReleaseRecovery(identity, digest) {
  return queue(async () => {
    const { withClaimOwnershipLock } = await import('./cosClaimOwnershipState.js');
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    const { inspectLegacyPublisher } = await import('./legacyReleaseRecovery.js');
    const initial = (await readOutbox()).publications[identity];
    if (!initial?.registeredAt || publisherCandidateSeed(initial)) refuse('Legacy recovery requires a registered unseeded publication');
    // Verify a potentially large existing archive outside the ownership lock.
    // The fenced pass rechecks its stamps, current bytes and every other fact.
    const prepared = await inspectLegacyPublisher(initial, await readBranchCompletionPolicies({ repairIndex: false }));
    if (prepared.digest !== digest) refuse('Legacy recovery review changed');
    const result = await withClaimOwnershipLock(async () => {
      const entry = (await readOutbox()).publications[identity];
      if (!entry?.registeredAt || publisherCandidateSeed(entry)) refuse('Legacy recovery requires a registered unseeded publication');
      const existing = entry.legacyRecovery ? legacyPublisherRecovery(entry) : null;
      if (entry.legacyRecovery && (!existing || existing.digest !== digest)) refuse('A different legacy recovery already exists');
      const proof = await inspectLegacyPublisher(entry, await readBranchCompletionPolicies({ repairIndex: false }), { archiveProof: prepared.archiveProof });
      if (proof.digest !== digest || !await proof.recheck()) refuse('Legacy recovery review changed');
      if (existing) return { receipt: existing, entry };
      entry.legacyRecovery = { version: 1, kind: 'legacy-publisher', digest, evidence: proof.evidence, acceptedAt: new Date().toISOString() };
      // Old verified synchronization was obtained without publisher proof. It
      // cannot survive acceptance until the independent obligations are inspected.
      entry.synchronization = { status: 'pending', attempts: entry.synchronization?.attempts || 0, checkedAt: new Date().toISOString(),
        retryAt: null, verifiedAt: null, blocker: null };
      if (!legacyPublisherRecovery(entry)) refuse('Legacy recovery evidence is incomplete');
      await saveReleaseSynchronization(entry);
      const saved = (await readOutbox()).publications[identity];
      if (!isDeepStrictEqual(saved?.legacyRecovery, entry.legacyRecovery)) refuse('Legacy recovery receipt was not retained');
      return { receipt: saved.legacyRecovery, entry: saved };
    });
    await emitReleaseSynchronization(result.entry, await readBranchCompletionPolicies({ repairIndex: false }));
    return result.receipt;
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
    || !evidence?.checkouts?.some(row => isDeepStrictEqual(row, target))) return false;
  const legacy = legacyPublisherRecovery(entry);
  const review = evidence.publisherReview;
  if (!legacy && (!review || review.path !== target.path || review.branch !== target.branch
    || review.head !== target.head || review.checkoutIdentity !== target.checkoutIdentity
    || review.prUrl !== `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`
    || !Array.isArray(review.models))) return false;
  const [{ readBranchCompletionPolicies }, { legacyProcessesSettled }] = await Promise.all([
    import('./branchCompletionPolicy.js'), import('./legacyReleaseRecovery.js'),
  ]);
  const agents = await readBranchCompletionPolicies({ repairIndex: false });
  return legacyProcessesSettled(entry, agents, release.path);
}

/** Expensive archive verification runs outside the ownership fence. Its
 * immutable file stamps and current content are checked again before removal. */
export async function prepareLegacyReleaseRetirement(release) {
  const outbox = await readOutbox();
  const entries = Object.values(outbox.publications).filter(entry => {
    const legacy = legacyPublisherRecovery(entry), target = publisherCandidateTarget(entry);
    return (legacy?.evidence.mode === 'present' && target?.path === release.path && target.branch === release.branch
      && target.head === release.head && target.checkoutIdentity === release.checkoutIdentity)
      || (entry.registeredAt && !publisherCandidateSeed(entry) && !entry.publication.candidateBranch
        && effectiveReleaseSynchronization(entry)?.status !== 'verified');
  });
  const proofs = new Map();
  if (!entries.length) return proofs;
  const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
  const { inspectLegacyPublisher } = await import('./legacyReleaseRecovery.js');
  const agents = await readBranchCompletionPolicies({ repairIndex: false });
  for (const entry of entries) {
    if (releaseSynchronizationReset(entry) || resetReleasesCheckout(entry, release)) continue;
    const legacy = legacyPublisherRecovery(entry);
    const target = publisherCandidateTarget(entry);
    if (legacy?.evidence.mode === 'present' && target?.path === release.path && target.branch === release.branch
      && target.head === release.head && target.checkoutIdentity === release.checkoutIdentity) {
      const proof = await inspectLegacyPublisher(entry, agents);
      if (proof.digest !== legacy.digest || proof.retirement || !await proof.recheck() || !proof.archiveProof) throw new Error('legacy-release-recovery-changed');
      proofs.set(entry.identity, proof.archiveProof);
    }
    if (!entry.publication.candidateBranch && release.repoPath) {
      const binding = await independentLegacyCheckout(entry, release, agents);
      const candidate = binding && await legacyPromotionBranch(entry, release.repoPath).catch(() => null);
      if (candidate && candidate !== release.branch) proofs.set(exclusionKey(entry), exclusionProof(entry, release, candidate, binding));
    }
  }
  return proofs;
}

/** Called under the ordinary checkout ownership fence immediately before a
 * legacy candidate can be unlocked or removed. It grants no removal authority. */
export async function validateLegacyReleaseRetirement(release, { unlocked = false, archiveProofs = new Map() } = {}) {
  const outbox = await readOutbox();
  const entries = Object.values(outbox.publications).filter(row => row.registeredAt && !publisherCandidateSeed(row)
    && effectiveReleaseSynchronization(row)?.status !== 'verified'
    && (!row.publication.candidateBranch || row.publication.candidateBranch === release.branch));
  if (!entries.length) return true;
  const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
  const { inspectLegacyPublisher, legacyProcessesSettled } = await import('./legacyReleaseRecovery.js');
  const agents = await readBranchCompletionPolicies({ repairIndex: false });
  for (const entry of entries) {
    if (releaseSynchronizationReset(entry) || resetReleasesCheckout(entry, release)) continue;
    if (entry.publication.candidateBranch && entry.publication.candidateBranch !== release.branch) continue;
    const [ownerRepo, targetRepo] = await Promise.all([realpath(entry.owner.workspace).catch(() => null), realpath(release.repoPath).catch(() => null)]);
    if (!targetRepo) return false;
    const sameRepository = !ownerRepo || samePath(ownerRepo, targetRepo);
    if (!sameRepository) continue;
    if (!entry.publication.candidateBranch && release.branch) {
      const prior = archiveProofs.get(exclusionKey(entry));
      const binding = prior && await independentLegacyCheckout(entry, release, agents);
      if (binding && prior.candidate && prior.candidate !== release.branch
        && isDeepStrictEqual(prior, exclusionProof(entry, release, prior.candidate, binding))) continue;
    }
    if (!ownerRepo) return false;
    const legacy = legacyPublisherRecovery(entry), target = publisherCandidateTarget(entry);
    if (!target || target.path !== release.path || target.branch !== release.branch) continue;
    if (!legacy || legacy.evidence.mode !== 'present'
      || target.head !== release.head || target.checkoutIdentity !== release.checkoutIdentity
      || entry.obligations.localReview.status !== 'verified' || entry.obligations.processSettlement.status !== 'verified') return false;
    const archiveProof = archiveProofs.get(entry.identity);
    if (!archiveProof) return false;
    const proof = await inspectLegacyPublisher(entry, agents, { unlocked, archiveProof });
    if (proof.digest !== legacy.digest || proof.retirement || !await proof.recheck()
      || !await legacyProcessesSettled(entry, agents, target.path)) return false;
  }
  return true;
}
