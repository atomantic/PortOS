/** A local investigation can join one verified owner without inventing success,
 * resetting a retry budget, or creating another investigation. */
import { z } from 'zod';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { isInvestigationTask } from '../lib/investigationTasks.js';
import { isTaskDeliveryComplete } from '../lib/agentOutcome.js';
import { matchesCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';
import { MAX_TOTAL_SPAWNS } from '../lib/cosValidation.js';
import { MAX_TASK_RETRIES } from './agentErrorAnalysis.js';
import { USER_DECISION_BLOCKED_CATEGORIES, PAUSED_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const investigationDependencyRequestSchema = z.object({ mode: z.literal('dependency-wait'),
  ownerTaskId: id, ownerAgentId: id, prUrl: z.string().url().max(2048) }).strict();
const dispatchSchema = z.object({ claimedBy: z.string().min(1), claimedAt: z.string().datetime(),
  lastSpawnedAt: z.string().datetime(), totalSpawnCount: z.union([z.number().int().nonnegative(), z.string().regex(/^(0|[1-9]\d*)$/)]) }).strict();
const originalSchema = z.object({ taskId: id, agentId: id, startedAt: z.string().datetime(),
  blockedAt: z.string().nullable(), lastSpawnedAt: z.string().nullable(), totalSpawnCount: z.string() }).strict();
const waitSchema = investigationDependencyRequestSchema.extend({ version: z.literal(1),
  phase: z.enum(['waiting', 'ready']), sourceAgentId: id, sourceStartedAt: z.string().datetime(),
  ownerStartedAt: z.string().datetime(), instanceId: z.string().min(1), repoPath: z.string().min(1),
  dispatch: dispatchSchema, ownerDispatch: dispatchSchema, originals: z.array(originalSchema).min(1).max(16), checks: z.number().int().nonnegative(), retryAt: z.string().datetime().nullable(),
  reason: z.string(), proof: z.object({ head: z.string(), mergeCommit: z.string() }).optional() }).strict();
const category = 'internal-dependency';
const flat = queues => [...(queues.user?.tasks || []).map(task => ({ ...task, taskType: 'user' })),
  ...(queues.cos?.tasks || []).map(task => ({ ...task, taskType: 'internal' }))];
const scoped = task => task?.taskType === 'internal' && isInvestigationTask(task)
  && isTruthyMeta(task.metadata?.blockedSystemRecovery) && isTruthyMeta(task.metadata?.preserveOriginalBudget);
const humanHeld = (task, allowExhausted = false) => isTruthyMeta(task?.approvalRequired) || !!task?.metadata?.blocker
  || task?.metadata?.taskOutcome?.recovery?.mode === 'approval'
  || /auth|permission|security|sandbox|forbidden|approval|quota|credits|spending|usage-limit/.test(task?.metadata?.lastErrorCategory || '')
  || (!(allowExhausted && task?.metadata?.blockedCategory === 'task-recovery-exhausted')
    && (USER_DECISION_BLOCKED_CATEGORIES.has(task?.metadata?.blockedCategory)
      || (task?.metadata?.blockedCategory !== category && PAUSED_BLOCKED_CATEGORIES.has(task?.metadata?.blockedCategory))));
const remaining = task => Number.isInteger(Number(task.metadata?.failureCount ?? 0))
  && Number(task.metadata?.failureCount ?? 0) >= 0 && Number(task.metadata?.failureCount ?? 0) < MAX_TASK_RETRIES
  && Number.isInteger(Number(task.metadata?.totalSpawnCount ?? 0))
  && Number(task.metadata?.totalSpawnCount ?? 0) >= 0 && Number(task.metadata?.totalSpawnCount ?? 0) < MAX_TOTAL_SPAWNS;
const repository = agent => agent?.metadata?.sourceWorkspace || agent?.metadata?.workspacePath;
const dispatch = task => Object.fromEntries(['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount']
  .map(key => [key, task.metadata?.[key] ?? null]));

async function sameRepository(a, b) {
  const { readGitCommonDirectory } = await import('../lib/gitRepositoryIdentity.js');
  const [left, right] = await Promise.all([readGitCommonDirectory(a), readGitCommonDirectory(b)]);
  return !!left && left === right;
}
async function delivered(owner, task, wait) {
  if (owner?.status !== 'completed' || task?.status !== 'completed') return null;
  const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
  const captures = owner.metadata?.completedCheckouts?.filter(row => completedCheckoutReceiptValid(owner, row)
    && (row.branch === owner.metadata.worktreeBranch || owner.metadata.claimBranches?.includes(row.branch))) || [];
  if (captures.length !== 1 || !await sameRepository(captures[0].repoPath, wait.repoPath)) return null;
  const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
  const capture = captures[0];
  const executionDelivered = isTaskDeliveryComplete(owner) && owner.result.validationPassed === true
    && owner.result.taskOutcome?.status === 'completed';
  // A later exact server verification can settle delivery without rewriting
  // the historical execution verdict. Neither the marker nor a receipt alone
  // replaces the fresh capture/forge/integration proof below.
  const verification = owner.metadata.repoStateVerification;
  const verifiedAfterExecution = verification?.status === 'completed' && verification.deliveryVerified === true
    && Object.values(owner.metadata.cleanupOutcomes || {}).some(row => row.status === 'verified'
      && row.branch === capture.branch && row.path === capture.path && row.committedIntegrationVerified === true);
  if (!executionDelivered && !verifiedAfterExecution) return null;
  const proof = await readRetirementForgeEvidence(wait.repoPath, capture.branch, wait.prUrl, { exactDeliveredHead: capture.head });
  if (proof.prHead !== capture.head || proof.scopeProof !== 'exact-delivered-head') return null;
  const { execGit } = await import('../lib/execGit.js');
  const included = await execGit(['merge-base', '--is-ancestor', proof.mergeCommit, proof.targetHead ?? proof.defaultHead],
    wait.repoPath, { ignoreExitCode: true, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } });
  return included.exitCode === 0 ? { head: capture.head, mergeCommit: proof.mergeCommit } : null;
}

export function _createInvestigationDependencyWait(deps = {}) {
  const read = deps.read || (async () => (await import('./cosTaskStore.js')).getAllTasks());
  const agent = deps.agent || (async key => (await import('./cosAgentLifecycle.js')).getAgentRecord(key));
  const instance = deps.instance || (async () => (await import('./instanceIdentity.js')).getInstanceId());
  const sameRepo = deps.sameRepo || sameRepository;
  const verifyDelivery = deps.delivered || delivered;
  const records = deps.records || (async () => (await import('./branchCompletionPolicy.js')).readBranchCompletionPolicies({ repairIndex: false }));
  const now = deps.now || Date.now;
  const update = deps.update || (async (task, patch) => (await import('./cosTaskStore.js')).updateTask(task.id, patch,
    task.taskType, { preserveRetryBudget: true, recoveryOwner: { id: task.metadata?.investigationDependencyWait?.sourceAgentId,
      startedAt: task.metadata?.investigationDependencyWait?.sourceStartedAt }, expectedStatus: task.status, expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata } }));
  const released = deps.released || (async owner => !(await import('./agentState.js')).getActiveAgentIds().includes(owner.id));
  const pointer = deps.pointer || (async owner => {
    const m = owner.metadata;
    const { resolveResumePointer } = await import('./agentWorktreeCleanup.js');
    const found = await resolveResumePointer(m.sourceWorkspace, m.worktreeBranch, m.workspacePath);
    return found?.branchName === m.worktreeBranch && found.worktreePath === m.workspacePath
      ? { existingBranch: found.branchName, resumeWorktreePath: found.worktreePath, resumedFromAgentId: owner.id } : null;
  });
  const local = (owner, task, instanceId) => owner?.taskId === task?.id && owner.metadata?.instanceId === instanceId
    && instanceId && instanceId !== 'unknown' && dispatchSchema.safeParse(dispatch(task)).success
    && owner.metadata?.completionTaskDispatch?.expected?.length === 4
    && Object.keys(dispatch(task)).every(key => owner.metadata.completionTaskDispatch.expected
      .filter(row => Array.isArray(row) && row.length === 2 && row[0] === key && row[1] != null).length === 1)
    && matchesCompletionTaskDispatch(owner, task);
  const sameAttempt = (row, captured) => ['lastSpawnedAt', 'totalSpawnCount'].every(key => row?.metadata?.[key] != null
    && captured[key] != null && String(row.metadata[key]) === String(captured[key]));
  const dependencyOwner = async (wait, target, instanceId) => {
    const original = await agent(wait.ownerAgentId);
    if (!target || original?.startedAt !== wait.ownerStartedAt) return null;
    if (sameAttempt(target, wait.ownerDispatch)) return local(original,
      { ...target, metadata: { ...target.metadata, ...wait.ownerDispatch } }, instanceId) ? original : null;
    // Discovery supplies locators only. Require one registered continuation,
    // never the newest unrelated execution of a reused task.
    const candidates = (await records()).filter(row => row.taskId === wait.ownerTaskId && row.status === 'completed');
    const verified = [];
    for (const candidate of candidates) {
      const expected = candidate.metadata?.completionTaskDispatch?.expected;
      if (!Array.isArray(expected)) continue;
      const charged = Object.fromEntries(expected);
      if (!sameAttempt(target, charged) || !local(candidate, { ...target, metadata: { ...target.metadata, ...charged } }, instanceId)) continue;
      const seen = new Set();
      let child = candidate;
      for (let depth = 0; depth < 16 && child && !seen.has(child.id); depth++) {
        seen.add(child.id);
        if (child.id === original.id) {
          if (child.startedAt === wait.ownerStartedAt
            && matchesCompletionTaskDispatch(child, { ...target, metadata: { ...target.metadata, ...wait.ownerDispatch } })) verified.push(candidate);
          break;
        }
        const parent = await agent(child.metadata?.resumedFromAgentId);
        const parentCount = Number(Object.fromEntries(parent?.metadata?.completionTaskDispatch?.expected || []).totalSpawnCount);
        const childCount = Number(Object.fromEntries(child.metadata?.completionTaskDispatch?.expected || []).totalSpawnCount);
        if (!parent || parent.status !== 'completed' || parent.taskId !== target.id || child.taskId !== target.id
          || parent.metadata?.instanceId !== instanceId || child.metadata?.instanceId !== instanceId
          || !Number.isSafeInteger(parentCount) || childCount !== parentCount + 1
          || !(Date.parse(parent.completedAt) <= Date.parse(child.startedAt))
          || parent.result?.executionInterruption || child.result?.executionInterruption
          || !parent.metadata.worktreeBranch || parent.metadata.worktreeBranch !== child.metadata.worktreeBranch
          || !await sameRepo(repository(parent), wait.repoPath) || !await sameRepo(repository(child), wait.repoPath)) break;
        child = parent;
      }
    }
    return verified.length === 1 ? verified[0] : null;
  };
  const resolve = async (input, outcome, agentId) => {
    const tasks = flat(await read());
    const task = tasks.find(row => row.id === input.id);
    const source = await agent(agentId);
    const instanceId = await instance();
    if (!scoped(task) || task.status !== 'in_progress' || humanHeld(task)
      || !local(source, task, instanceId) || source.status !== 'running') throw new Error('investigation-dependency-source-unverified');
    const parsed = investigationDependencyRequestSchema.safeParse(outcome.recovery);
    let wait = null;
    let reason = 'Dependency ownership, scope or dispatch could not be verified.';
    if (parsed.success && scoped(task) && task.status === 'in_progress' && !humanHeld(task)
      && local(source, task, instanceId) && source.status === 'running') {
      const request = parsed.data;
      const target = tasks.find(row => row.id === request.ownerTaskId);
      const owner = await agent(request.ownerAgentId);
      const originals = Array.isArray(task.metadata.affectedTasks) ? task.metadata.affectedTasks : [];
      const seen = new Set([task.id]);
      let cursor = target, cycle = false;
      for (let depth = 0; cursor; depth++) {
        if (depth >= 16 || seen.has(cursor.id)) { cycle = true; break; }
        seen.add(cursor.id);
        cursor = tasks.find(row => row.id === cursor.metadata?.investigationDependencyWait?.ownerTaskId);
      }
      const sourceRepo = repository(source);
      let originalsBound = originals.length > 0 && originals.length <= 16;
      const originalBindings = [];
      for (const originalId of originals) {
        const original = tasks.find(row => row.id === originalId);
        const originalOwner = original && await agent(original.metadata?.deliveryDecisionAgentId
          || original.metadata?.lastAgentId || original.metadata?.failedAgentId);
        if (!original || original.status !== 'blocked' || humanHeld(original, true) || originalOwner?.status !== 'completed' || originalOwner?.taskId !== original.id
          || originalOwner.metadata?.instanceId !== instanceId || !await sameRepo(repository(originalOwner), sourceRepo)) originalsBound = false;
        else originalBindings.push({ taskId: original.id, agentId: originalOwner.id, startedAt: originalOwner.startedAt,
          blockedAt: original.metadata.blockedAt || null, lastSpawnedAt: original.metadata.lastSpawnedAt || null,
          totalSpawnCount: String(original.metadata.totalSpawnCount ?? '') });
      }
      if (!cycle && originalsBound && target && !humanHeld(target) && target.status === 'in_progress'
        && local(owner, target, instanceId) && owner.status === 'running'
        && await sameRepo(sourceRepo, repository(owner))) {
        wait = { ...request, version: 1, phase: 'waiting', sourceAgentId: agentId, sourceStartedAt: source.startedAt,
          ownerStartedAt: owner.startedAt, instanceId, repoPath: sourceRepo, dispatch: dispatch(task), ownerDispatch: dispatch(target), originals: originalBindings,
          checks: 0, retryAt: null, reason: 'Waiting for the existing local owner’s verified delivery; no correction is claimed.' };
        if (!waitSchema.safeParse(wait).success) wait = null;
      }
      if (wait) reason = wait.reason;
    }
    // Even an invalid dependency request cannot become success or refund budget.
    return { status: 'blocked', dependencyWaitContext: { expectedStatus: task?.status || input.status,
      expectedTask: { description: task?.description || input.description, priority: task?.priority || input.priority,
        metadata: task?.metadata || input.metadata } },
      metadata: { ...(task?.metadata || input.metadata), taskOutcome: outcome,
        investigationDependencyWait: wait || undefined, deliveryDecisionAgentId: agentId,
        blockedCategory: wait ? category : 'internal-dependency-unverified', blockedAt: new Date(now()).toISOString(),
        blockedReason: reason, deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined } };
  };
  let tail = Promise.resolve();
  let cursor = 0;
  const reconcile = () => {
    const run = tail.then(async () => {
      const tasks = flat(await read());
      const instanceId = await instance();
      const resumed = [];
      const waiting = tasks.filter(task => task.status === 'blocked' && task.metadata?.blockedCategory === category);
      const start = waiting.length ? cursor % waiting.length : 0;
      const candidates = [...waiting.slice(start), ...waiting.slice(0, start)].slice(0, 3);
      cursor = waiting.length ? (start + candidates.length) % waiting.length : 0;
      for (const task of candidates) {
        const parsed = waitSchema.safeParse(task.metadata.investigationDependencyWait);
        if (!parsed.success || !scoped(task) || humanHeld(task) || task.metadata?.spawnBudgetReconciledHold === 'true') continue;
        const wait = parsed.data;
        if (wait.phase !== 'waiting' || wait.instanceId !== instanceId
          || (wait.retryAt && Date.parse(wait.retryAt) > now())) continue;
        const source = await agent(wait.sourceAgentId);
        const target = tasks.find(row => row.id === wait.ownerTaskId);
        const owner = await dependencyOwner(wait, target, instanceId).catch(() => null);
        if (source?.status !== 'completed' || source.startedAt !== wait.sourceStartedAt
          || !owner || !target || humanHeld(target) || !sameAttempt(task, wait.dispatch)
          || !matchesCompletionTaskDispatch(source, { ...task, metadata: { ...task.metadata, ...wait.dispatch } })
          || !await sameRepo(repository(source), wait.repoPath) || !await sameRepo(repository(owner), wait.repoPath)) continue;
        let originalsBound = true;
        for (const binding of wait.originals) {
          const original = tasks.find(row => row.id === binding.taskId);
          const originalOwner = await agent(binding.agentId);
          if (!original || original.status !== 'blocked' || humanHeld(original, true)
            || originalOwner?.status !== 'completed' || originalOwner.startedAt !== binding.startedAt
            || originalOwner.taskId !== original.id || originalOwner.metadata?.instanceId !== instanceId
            || (original.metadata.blockedAt || null) !== binding.blockedAt
            || (original.metadata.lastSpawnedAt || null) !== binding.lastSpawnedAt
            || String(original.metadata.totalSpawnCount ?? '') !== binding.totalSpawnCount
            || !await sameRepo(repository(originalOwner), wait.repoPath)) originalsBound = false;
        }
        if (!originalsBound) continue;
        // No provider work is scheduled for status-only updates or missing proof.
        if (target.status !== 'completed' || !await released(source)) continue;
        const proof = await verifyDelivery(owner, target, wait).catch(() => null);
        const resume = proof && remaining(task) ? await pointer(source).catch(() => null) : null;
        if (!proof || !remaining(task) || !resume) {
          const checks = Math.min(16, wait.checks + 1);
          await update(task, { metadata: { investigationDependencyWait: { ...wait, checks,
            retryAt: new Date(now() + Math.min(3600000, 60000 * 2 ** (checks - 1))).toISOString(),
            reason: !remaining(task) ? 'The investigation’s own retry budget is exhausted; no new run was authorized.'
              : !proof ? 'Dependency delivery proof is not verified.' : 'The investigation’s original checkout cannot be safely resumed.' } } });
          continue;
        }
        const saved = await update(task, { status: 'pending', metadata: { ...resume,
          investigationDependencyWait: { ...wait, phase: 'ready', proof, retryAt: null,
            reason: 'Verified dependency delivered; continue the same investigation and verify the original failure.' },
          blockedCategory: undefined, blockedAt: undefined, blockedReason: undefined } });
        if (saved?.status === 'pending' && !saved.error && !saved.statusChanged) resumed.push(task.id);
      }
      return { resumed };
    });
    tail = run.catch(() => {});
    return run;
  };
  const bind = events => {
    const wake = data => {
      if (data?.suppressCompletionWake || data?.task?.status !== 'completed') return;
      return reconcile().catch(async error => {
        const { emitLog } = await import('./cosEvents.js');
        emitLog('warn', `Investigation dependency verification deferred: ${error.message}`);
      });
    };
    events.on('tasks:changed', wake);
    return () => events.off('tasks:changed', wake);
  };
  return { resolve, reconcile, bind };
}
const service = _createInvestigationDependencyWait();
export const resolveInvestigationDependencyUpdate = (...args) => service.resolve(...args);
export const reconcileInvestigationDependencies = () => service.reconcile();
export const bindInvestigationDependencyEvents = events => service.bind(events);
