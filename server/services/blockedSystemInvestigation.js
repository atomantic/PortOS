/** Reuse the existing investigator for a locally executed system failure.
 * This diagnoses the cause; it never revives work or refunds its retry budget. */
import { buildInvestigationFingerprint, isInvestigationTask } from '../lib/investigationTasks.js';
import { USER_DECISION_BLOCKED_CATEGORIES, PAUSED_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { explicitPrCompletion, PR_COMPLETIONS } from '../lib/prDisposition.js';
import { isPrivateSecurityTask } from '../lib/privateSecurityPolicy.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';

const BACKOFF_MS = 60000;
const MAX_BACKOFF_MS = 3600000;
const humanBoundaries = new Set(['auth-error', 'forbidden', 'permission-denied', 'permission-error', 'approval-required',
  'tool-approval', 'access-denied', 'security-refusal', 'sandbox-denied', 'content-refusal', 'content-filtered',
  'quota-exhausted', 'usage-limit', 'budget-exceeded', 'spending-limit', 'credits-exhausted', 'private-security-assessment-failed']);
const flatten = queues => [...(queues.cos?.tasks || []).map(task => ({ ...task, taskType: 'internal' })),
  ...(queues.user?.tasks || []).map(task => ({ ...task, taskType: 'user' }))];
const eligible = task => {
  const m = task?.metadata || {};
  const category = m.blockedCategory;
  return task?.taskType === 'internal' && task.status === 'blocked' && typeof category === 'string'
    && !isInvestigationTask(task) && !isPrivateSecurityTask(task) && !isTruthyMeta(task.approvalRequired)
    && !(typeof m.blocker === 'string' && m.blocker.trim())
    && m.recoveryOrigin?.subsystem !== 'repository-cleanup'
    && m.taskOutcome?.recovery?.mode !== 'approval'
    && explicitPrCompletion(task) !== PR_COMPLETIONS.LEAVE_OPEN
    && (!USER_DECISION_BLOCKED_CATEGORIES.has(category) || category === 'task-recovery-exhausted')
    && (!PAUSED_BLOCKED_CATEGORIES.has(category) || category === 'task-recovery-exhausted')
    && ![category, m.lastErrorCategory].some(value => typeof value === 'string' && humanBoundaries.has(value.toLowerCase()));
};
const analysisFor = task => ({
  category: `blocked-system-${task.metadata.blockedCategory}-${task.metadata.lastErrorCategory || task.metadata.taskOutcome?.status || 'failure'}`,
  message: 'A system task stopped before its work reached verified completion.',
  snippet: task.metadata.blockedReason || task.metadata.taskOutcome?.reason,
  blockedSystemRecovery: true,
  preserveOriginalBudget: true,
  escalation: 'Re-read the original task, current owners and delivery evidence first. Reuse active fixes. Resolve the affected work within its original authority and budgets. Diagnose the underlying machine/product cause; repair a demonstrated code defect in an isolated checkout with a regression test, required review, CI, merge admission and own-checkout cleanup. Reuse and link an existing active fix instead of duplicating it. Do not invent code defects for external permission failures or transient causes; record those accurately. Preserve unfinished work and original failure/spawn budgets. Do not requeue, reset, or mark the original task completed by hand; its existing verifier and budget rules own continuation. Do not retry denied operations, change credentials, spend limits or permissions, or bypass a genuine human approval. Report actual human-required boundaries on the original record; machine-recoverable failures must not create personal Brain/todo actions.',
});
const phaseFor = task => task.status === 'in_progress' ? 'investigating'
  : task.status === 'completed' ? 'diagnosed'
    : task.status === 'blocked' || isTruthyMeta(task.approvalRequired) ? 'investigation-blocked' : 'queued';

async function localOwner(task) {
  const agentId = task.metadata?.deliveryDecisionAgentId || task.metadata?.lastAgentId || task.metadata?.failedAgentId;
  if (!agentId) return null;
  const [{ getAgentRecord }, { getInstanceId, UNKNOWN_INSTANCE_ID }] = await Promise.all([
    import('./cosAgentLifecycle.js'), import('./instanceIdentity.js'),
  ]);
  const [agent, instanceId] = await Promise.all([getAgentRecord(agentId), getInstanceId()]);
  return instanceId && instanceId !== UNKNOWN_INSTANCE_ID && agent?.status === 'completed'
    && agent.taskId === task.id && agent.metadata?.instanceId === instanceId
    ? { agentId, instanceId } : null;
}

/** Persistence/producer seams let lifecycle tests exercise crash and replay with
 * a real task store adapter, without running providers or touching host tasks. */
export function _createBlockedSystemInvestigationRecovery(deps = {}) {
  const now = deps.now || Date.now;
  const read = deps.read || (async () => (await import('./cosTaskStore.js')).getAllTasks());
  const ownerFor = deps.ownerFor || localOwner;
  const update = deps.update || (async (task, state) => (await import('./cosTaskStore.js')).updateTask(task.id,
    { metadata: { blockedInvestigation: state } }, 'internal', { expectedStatus: 'blocked',
      expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata } }));
  const permission = deps.permission || (async (fingerprint, tasks) => {
    const producer = await import('./investigationTaskProducer.js');
    if (producer.investigationCircuitOpen(now())) return 'circuit-open';
    return (await producer.resolveAutoInvestigationApproval(fingerprint, { now: now(), tasks })).loopReason;
  });
  const create = deps.create || (async (task, analysis, owner) => (await import('./agentErrorAnalysis.js'))
    .createInvestigationTask(owner.agentId, task, analysis));
  let tail = Promise.resolve();
  const write = async (task, state) => {
    if (JSON.stringify(task.metadata?.blockedInvestigation) === JSON.stringify(state)) return task;
    const saved = await update(task, state);
    return saved?.error || saved?.statusChanged ? null : saved;
  };
  const one = async id => {
    const tasks = flatten(await read());
    let task = tasks.find(row => row.id === id && row.taskType === 'internal');
    if (!eligible(task)) return { handled: false };
    const owner = await ownerFor(task);
    if (!owner) return { handled: false, reason: 'local-owner-unverified' };
    const analysis = analysisFor(task);
    const fingerprint = buildInvestigationFingerprint(task, analysis);
    const epoch = `${fingerprint}:${task.metadata.blockedAt || task.metadata.lastSpawnedAt || 'legacy'}`;
    const old = task.metadata.blockedInvestigation;
    let state = old?.epoch === epoch ? { ...old } : { version: 1, epoch, fingerprint, attempts: 0, failures: 0,
      ownerInstanceId: owner.instanceId, sourceCategory: task.metadata.blockedCategory,
      sourceBlockedAt: task.metadata.blockedAt || task.metadata.lastSpawnedAt || 'legacy' };
    const related = tasks.filter(row => isInvestigationTask(row) && row.metadata?.investigationFingerprint === fingerprint);
    const existing = related.find(row => row.id === state.taskId)
      || related.find(row => ['pending', 'in_progress', 'blocked'].includes(row.status));
    if (existing) {
      state = { ...state, taskId: existing.id, attempts: 1, phase: phaseFor(existing), retryAt: null };
      if (!existing.metadata?.affectedTasks?.includes(task.id)) await create(task, analysis, owner);
      await write(task, state);
      return { handled: true, phase: state.phase, taskId: existing.id };
    }
    if (Number(state.version) !== 1 || !Number.isSafeInteger(Number(state.attempts)) || Number(state.attempts) < 0) {
      return { handled: false, reason: 'recovery-state-unreadable' };
    }
    // One investigator owns this blocked episode, including its own configured
    // retries. Losing/failing that investigator does not mint a fresh budget.
    if (Number(state.attempts) >= 1) {
      await write(task, { ...state, phase: 'budget-exhausted', retryAt: null });
      return { handled: true, phase: 'budget-exhausted' };
    }
    if (Number.isFinite(Date.parse(state.retryAt)) && Date.parse(state.retryAt) > now()) return { handled: true, phase: 'waiting' };
    const defer = async reason => {
      const failures = Math.min(16, Math.max(0, Number(state.failures) || 0) + 1);
      await write(task, { ...state, phase: 'waiting', failures, reason,
        retryAt: new Date(now() + Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (failures - 1))).toISOString() });
      return { handled: true, phase: 'waiting', reason };
    };
    const held = await permission(fingerprint, tasks);
    if (held) return defer(held);
    task = await write(task, { ...state, phase: 'creating', retryAt: new Date(now() + BACKOFF_MS).toISOString() });
    if (!task) return { handled: false, reason: 'task-changed' };
    // An explicit user/owner transition during preparation wins over recovery.
    const current = flatten(await read()).find(row => row.id === task.id && row.taskType === 'internal');
    if (!eligible(current) || current.metadata.blockedInvestigation?.epoch !== epoch) return { handled: false, reason: 'task-changed' };
    task = current;
    const created = await create(task, analysis, owner).catch(() => null);
    if (!created?.id) return defer('producer-unavailable');
    state = { ...state, attempts: 1, taskId: created.id, phase: phaseFor(created), retryAt: null };
    await write(task, state);
    return { handled: true, phase: state.phase, taskId: created.id };
  };
  const recover = id => {
    const result = tail.then(() => one(id));
    tail = result.catch(() => {});
    return result;
  };
  let cursor = 0;
  const sweep = async () => {
    const all = flatten(await read()).filter(eligible);
    const start = all.length ? cursor % all.length : 0;
    const candidates = [...all.slice(start), ...all.slice(0, start)].slice(0, 3);
    cursor = all.length ? (start + candidates.length) % all.length : 0;
    const results = [];
    for (const task of candidates) results.push(await recover(task.id));
    return results;
  };
  return { recover, sweep };
}

const recovery = _createBlockedSystemInvestigationRecovery();
export const recoverBlockedSystemTask = taskId => recovery.recover(taskId);
export const recoverBlockedSystemTasks = () => recovery.sweep();
