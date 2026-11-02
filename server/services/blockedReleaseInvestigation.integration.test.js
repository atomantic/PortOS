import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ agent: null, autoApprove: true, onConfig: null }));
vi.mock('./cosState.js', async () => ({
  withStateLock: (await import('../lib/fileWriteQueue.js')).createFileWriteQueue(),
  loadState: vi.fn(async () => ({ agents: fixture.agent ? { [fixture.agent.id]: fixture.agent } : {} })),
  readAgentsStateForSafetyCheck: vi.fn(async () => ({ trusted: true, agents: fixture.agent ? { [fixture.agent.id]: fixture.agent } : {} })),
  getConfig: vi.fn(async () => {
    if (fixture.onConfig) { const action = fixture.onConfig; fixture.onConfig = null; await action(); }
    return { autoApproveInvestigations: fixture.autoApprove };
  }),
}));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgentRecord: vi.fn(async () => fixture.agent) }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'fixture-local'), UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./agentState.js', async importOriginal => ({ ...(await importOriginal()), activeAgents: new Map(), runnerAgents: new Map() }));
vi.mock('./codeReview.js', () => ({ runLocalCodeReview: vi.fn(), getCodeReviewDefaults: vi.fn(async () => ({})) }));
vi.mock('./cosEvents.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { cosEvents: new EventEmitter(), emitLog: vi.fn() };
});

const { _createBlockedSystemInvestigationRecovery } = await import('./blockedSystemInvestigation.js');
const { addTask, getAllTasks, getTaskById, updateTask, __resetTaskCache } = await import('./cosTaskStore.js');
const { __resetCosTaskRepository, loadTaskWorkingSet, applyTaskListSave } = await import('./cosTaskRepository.js');
const { __resetInvestigationCircuit, createInvestigationTask } = await import('./agentErrorAnalysis.js');
const { retryTasksResolvedByInvestigation } = await import('./investigationRetry.js');
const { buildInvestigationFingerprint } = await import('../lib/investigationTasks.js');
const { planListSave } = await import('../lib/cosTaskRows.js');

async function holdSourceApproval() {
  const snapshot = await loadTaskWorkingSet('internal');
  const next = snapshot.rows.map(row => row.task.id === 'sys-release'
    ? { ...row.task, approvalRequired: true, autoApproved: false } : row.task);
  const plan = planListSave({ previous: snapshot.rows, next, source: 'internal' });
  await applyTaskListSave('internal', { ...plan, expectedVersions: { internal: snapshot.version } });
  __resetTaskCache();
}

beforeEach(async () => {
  __resetCosTaskRepository();
  __resetTaskCache();
  __resetInvestigationCircuit();
  fixture.autoApprove = true;
  fixture.onConfig = null;
  fixture.agent = { id: 'agent-coordinator', taskId: 'sys-release', status: 'completed', startedAt: '2026-01-01T00:00:00Z',
    metadata: { instanceId: 'fixture-local', taskAnalysisType: 'do-release', releaseCandidateRecovery: {
      version: 1, status: 'held', predecessorAgentId: 'agent-prior', reason: 'candidate-successor-lineage-unverified',
    } } };
  await addTask({ id: 'sys-release', description: 'Do release', priority: 'LOW', status: 'blocked', metadata: {
    app: 'portos-default', analysisType: 'do-release', blockedCategory: 'task-approval', blockedAt: '2026-01-01T00:01:00Z',
    blockedReason: 'Recovery needs attention', deliveryDecisionAgentId: 'agent-coordinator', totalSpawnCount: '2',
    taskOutcome: { status: 'blocked', reason: 'Recovery needs attention', recovery: { mode: 'approval', options: ['Preserve', 'Abandon'] } },
  } }, 'internal', { raw: true });
});

describe('approval-held release investigation', () => {
  it.each([true, false])('uses the configured auto-approval setting (%s) and never retries the original', async autoApprove => {
    fixture.autoApprove = autoApprove;
    const before = await getTaskById('sys-release');
    const recovery = _createBlockedSystemInvestigationRecovery();
    const result = await recovery.recover('sys-release');
    const investigator = await getTaskById(result.taskId);
    expect(investigator).toMatchObject({ status: 'pending', approvalRequired: !autoApprove,
      metadata: { isInvestigation: 'true', blockedSystemRecovery: 'true', preserveOriginalBudget: 'true', affectedTasks: ['sys-release'] } });
    expect(investigator.metadata.prompt).toContain('The release approval remains in force');
    expect(await retryTasksResolvedByInvestigation({ ...investigator, status: 'completed' })).toEqual({ retried: [], skipped: [] });
    const original = await getTaskById('sys-release');
    expect(original.status).toBe('blocked');
    expect(original.metadata.taskOutcome).toEqual(before.metadata.taskOutcome);
    expect(original.metadata.totalSpawnCount).toBe(before.metadata.totalSpawnCount);
    await recovery.sweep();
    expect((await getAllTasks()).cos.tasks.filter(task => task.metadata?.isInvestigation)).toHaveLength(1);
  });

  it.each(['metadata', 'approval'])('does not queue an investigator if the owner changes %s while creation is in flight', async field => {
    fixture.onConfig = async () => {
      if (field === 'approval') await holdSourceApproval();
      else await updateTask('sys-release', { metadata: { blockedReason: 'Changed by the owner' } }, 'internal');
    };
    await _createBlockedSystemInvestigationRecovery().recover('sys-release');
    const { cos } = await getAllTasks();
    expect(cos.tasks.filter(task => task.metadata?.isInvestigation)).toHaveLength(0);
    const source = await getTaskById('sys-release');
    if (field === 'approval') expect(source.approvalRequired).toBe(true);
    else expect(source.metadata.blockedReason).toBe('Changed by the owner');
  });

  it('does not link a changed approval to an existing investigation', async () => {
    const source = await getTaskById('sys-release');
    const fingerprint = buildInvestigationFingerprint(source, { category: 'blocked-system-candidate-successor-lineage-unverified' });
    await addTask({ id: 'sys-existing', description: 'Existing investigator', priority: 'HIGH', status: 'pending', metadata: {
      isInvestigation: true, investigationFingerprint: fingerprint, affectedTasks: ['sys-other'],
    } }, 'internal', { raw: true });
    const recovery = _createBlockedSystemInvestigationRecovery({ create: async (task, analysis, owner) => {
      await holdSourceApproval();
      return createInvestigationTask(owner.agentId, task, analysis, { expectedSourceTask: task });
    } });
    expect(await recovery.recover('sys-release')).toEqual({ handled: false, reason: 'investigation-source-changed' });
    expect((await getTaskById('sys-existing')).metadata.affectedTasks).toEqual(['sys-other']);
    expect((await getTaskById('sys-release')).approvalRequired).toBe(true);
  });
});
