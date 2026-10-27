/** Machine-local publication outbox. It owns work, never merge or deletion authority.
 * Keep immutable dispatches after completion: queue history retention is not an
 * idempotency boundary, and a failed run does not unpublish a release.
 */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { RELEASE_SYNC_POLICY_KEYS, RELEASE_SYNC_FROZEN_METADATA_KEYS, RELEASE_SYNC_OBLIGATIONS } from '../lib/releaseSynchronization.js';
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
      && entry.synchronization?.status !== 'verified') ? 'wait-for-synchronization' : null;
  }
  const entry = outbox.publications[task.metadata?.releaseSynchronization?.identity];
  if (!entry?.registeredAt || task.id !== entry.task.id) return null;
  const expected = { ...entry.task.metadata,
    idempotencyKey: createHash('sha256').update(JSON.stringify([entry.identity, entry.owner])).digest('hex') };
  return RELEASE_SYNC_FROZEN_METADATA_KEYS.every(key => isDeepStrictEqual(task.metadata?.[key], expected[key]))
    ? 'registered-continuation' : null;
}

/** Agent archives remain verifier input until the corresponding durable outbox
 * has verified every obligation. This is retention evidence, not cleanup or
 * merge authority. Read without the task-publication queue: callers hold the
 * agent-state lock, which task registration may itself need. */
export async function readReleaseSynchronizationRetention() {
  const outbox = await readOutbox();
  return Object.values(outbox.publications).map(entry => ({
    identity: entry.identity, owner: entry.owner, taskId: entry.task.id,
    verified: entry.synchronization?.status === 'verified',
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
  return { taskId: saved.id, registeredAt: entry.registeredAt, synchronizationVerified: entry.synchronization?.status === 'verified' };
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
    if (previous?.registeredAt || (previous?.retryAt && Date.parse(previous.retryAt) > Date.now()) || attempted.has(identity)) continue;
    attempted.add(identity);
    await ensureReleaseSynchronization(agent).catch(error => {
      console.log(`🚫 Release synchronization handoff retained for ${agent.id}: ${error.code || 'registration-unavailable'}`);
    });
  }
  const due = await queue(async () => {
    const outbox = await readOutbox();
    for (const entry of Object.values(outbox.publications).filter(value => !value.registeredAt && !attempted.has(value.identity)
      && (!value.retryAt || Date.parse(value.retryAt) <= Date.now()))) {
      await registerEntry(entry).catch(async error => {
        await retainFailure(entry, error);
      });
    }
    return Object.values(outbox.publications).filter(entry => entry.registeredAt
      && entry.synchronization?.status !== 'verified'
      && (!entry.synchronization?.retryAt || Date.parse(entry.synchronization.retryAt) <= Date.now()))
      .sort((left, right) => (left.synchronization?.checkedAt || '').localeCompare(right.synchronization?.checkedAt || ''))
      .slice(0, 3).map(entry => entry.task.id);
  });
  for (const taskId of due) await verifyReleaseSynchronizationTask(taskId, { agents, respectRetryAt: true });
}

async function verifyEntry(entry, agents) {
  const result = agents.some(agent => agent.taskId === entry.task.id)
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
  return entry.synchronization;
}

/** Inspect one continuation independently of its execution verdict. Only this task's enrolled outbox can authorize inspection.
 */
export function verifyReleaseSynchronizationTask(taskId, { agents = null, respectRetryAt = false } = {}) {
  return queue(async () => {
    const outbox = await readOutbox();
    const entry = Object.values(outbox.publications).find(value => value.task.id === taskId && value.registeredAt);
    if (!entry || entry.synchronization?.status === 'verified') return entry?.synchronization || null;
    if (respectRetryAt && entry.synchronization?.retryAt && Date.parse(entry.synchronization.retryAt) > Date.now()) return entry.synchronization;
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    return verifyEntry(entry, agents || await readBranchCompletionPolicies({ repairIndex: false }));
  });
}

/** Retirement runs this outside its ownership fence. The ordinary retirement
 * transaction still rechecks the exact generation and all removal authority.
 */
export function retainReleaseSynchronizationReview(release) {
  return queue(async () => {
    const outbox = await readOutbox();
    const entries = Object.values(outbox.publications).filter(entry => entry.registeredAt && entry.synchronization?.status !== 'verified');
    if (!entries.length) return true;
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    const { retirementCheckoutIdentityFromPointer } = await import('../lib/retirementCheckoutObservation.js');
    const agents = await readBranchCompletionPolicies({ repairIndex: false });
    for (const entry of entries) {
      const owns = agents.some(agent => agent.taskId === entry.task.id && agent.metadata?.checkoutSeeds?.some(seed =>
        seed.branch === release.branch && seed.path === release.path
        && retirementCheckoutIdentityFromPointer(seed.incarnation?.pointer) === release.checkoutIdentity));
      if (!owns) continue;
      await verifyEntry(entry, agents);
      const review = entry.obligations.localReview;
      const retained = entry.obligations.retirement.evidence;
      if (review.status !== 'verified' || review.evidence?.prUrl !== retained?.prUrl
        || !retained?.checkouts?.some(row => row.branch === release.branch && row.path === release.path
          && row.head === release.head && row.checkoutIdentity === release.checkoutIdentity)) return false;
    }
    return true;
  });
}
