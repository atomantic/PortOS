import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-finalization-output-') }));
afterAll(cleanupTempDataRoots);
const mergedTarget = vi.hoisted(() => ({
  getOriginInfo: vi.fn(),
  probeChangeRequestState: vi.fn(),
}));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: mergedTarget.getOriginInfo }));
vi.mock('./prProbe.js', () => ({ probeChangeRequestState: mergedTarget.probeChangeRequestState }));
const claimVerifier = vi.hoisted(() => ({ verifyClaimDisposition: vi.fn() }));
vi.mock('./claimDisposition.js', () => claimVerifier);
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, tryReadFile: vi.fn(actual.tryReadFile) };
});
import { tryReadFile } from '../lib/fileUtils.js';
const deep = vi.hoisted(() => ({ checkpointDeepAudit: vi.fn(async () => ({ id: 'deep-1', complete: false, reason: 'Checkpoint partial' })), settleDeepAuditDelivery: vi.fn(async () => ({ id: 'deep-1', complete: false, reason: 'Checkpoint partial' })) }));
vi.mock('./deepAudit.js', () => deep);
vi.mock('../lib/gitCommitProbe.js', () => ({ committedDuringRun: vi.fn(async () => false) }));
vi.mock('./appQuality.js', () => ({ recordAuditQuality: vi.fn(async () => true) }));
import { recordAuditQuality } from './appQuality.js';
// Hoisted doubles rather than static imports: the audit path reaches both modules
// lazily, and importing them here would drag their subtrees into this suite's closure.
const appsRegistry = vi.hoisted(() => ({ getAppById: vi.fn(async () => null) }));
vi.mock('./apps.js', () => appsRegistry);
const snapshotFile = vi.hoisted(() => ({ publishAppQualitySnapshot: vi.fn(async () => ({ published: true, hash: 'abc1234' })) }));
vi.mock('./appQualitySnapshotFile.js', () => snapshotFile);
const inlineReleaseVerification = vi.hoisted(() => vi.fn(async () => ({ verified: false, reason: 'synchronization-pr-not-merged' })));
vi.mock('./releaseSynchronization.js', () => ({ verifyInlineReleaseDelivery: inlineReleaseVerification }));
// The goal-fidelity gate (#5994) reaches a local model at completion. Pinned OFF
// here so these tests exercise the path they are about without depending on the
// developer's own reviewer settings — and so a machine that HAS a local reviewer
// configured never has its suite dispatch a real review request.
vi.mock('./codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: vi.fn(async () => null),
}));

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(),
  getAgentRecord: vi.fn(async () => null),
  updateAgent: vi.fn(),
  completeAgent: vi.fn(),
}));

vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => true),
  getTaskOutputHook: vi.fn(),
  getTaskOutputPayloadPredicate: vi.fn(async () => null),
  declaresNoCommitCriterion: vi.fn(() => false),
  isClaimFlowDispatch: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => true),
  resolveTaskHookType: vi.fn(task => task?.metadata?.analysisType || null),
}));

import { getAgent, getAgentRecord, updateAgent, completeAgent } from './cosAgentLifecycle.js';
import { canRunTaskOutputHookWithoutPayload, declaresNoCommitCriterion, getTaskOutputHook, isProgrammaticIoTaskType } from './taskTypeHooks.js';
import {
  finalizeAgent,
  retireDeadAgent,
  dispatchRecoveredTaskOutputHook,
  dispatchTaskOutputHookOnce,
} from './agentFinalization.js';


vi.mock('./cosTaskStore.js', () => ({
  updateTask: vi.fn(async () => ({})),
  getTaskById: vi.fn(async () => null),
  addTask: vi.fn(async () => ({ id: 'investigation-test' })),
}));
vi.mock('./investigationTaskProducer.js', () => ({
  investigationCircuitOpen: vi.fn(() => false),
  noteInvestigationFiled: vi.fn(),
  readAllTasksFlat: vi.fn(async () => []),
  recentInvestigationCreations: vi.fn(() => []),
}));
vi.mock('./agentErrorAnalysis.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, resolveFailedTaskUpdate: vi.fn(actual.resolveFailedTaskUpdate) };
});
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn(async () => null) }));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));
import { emitLog } from './cosEvents.js';
vi.mock('./taskSchedule.js', () => ({
  recordTaskTypeFailure: vi.fn(async () => null),
  recordTaskTypeSuccess: vi.fn(async () => null),
  recordRecommendedAudits: vi.fn(async () => null),
}));
import { updateTask, addTask, getTaskById } from './cosTaskStore.js';
import { completeAgentRun } from './agentRunTracking.js';
import { processAgentCompletion } from './agentCompletion.js';
import { MAX_TASK_RETRIES, resolveFailedTaskUpdate } from './agentErrorAnalysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANAGEMENT_SOURCE = readFileSync(join(__dirname, 'agentManagement.js'), 'utf8');
const LIFECYCLE_SOURCE = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf8');
const TASK = {
  id: 'sys-example',
  taskType: 'internal',
  metadata: {
    analysisType: 'example-output-hook',
    app: 'app-example',
    repoPath: '/example/repo',
  },
};

describe('recovery output-hook dispatch (#3182)', () => {
  let persistedAgent;
  let hook;

  beforeEach(() => {
    vi.clearAllMocks();
    persistedAgent = {
      id: 'agent-example',
      status: 'running',
      startedAt: '2026-09-10T00:00:00Z',
      metadata: {},
    };
    getAgent.mockImplementation(async () => persistedAgent);
    getAgentRecord.mockImplementation(async () => persistedAgent);
    updateAgent.mockImplementation(async (_agentId, updates) => {
      persistedAgent = {
        ...persistedAgent,
        metadata: { ...persistedAgent.metadata, ...updates.metadata },
      };
      return persistedAgent;
    });
    hook = vi.fn().mockResolvedValue({ recorded: true });
    getTaskOutputHook.mockResolvedValue(hook);
  });

  it('awaits the scheduled outcome ledger and finishes even when that write fails', async () => {
    const { recordTaskTypeSuccess, recordTaskTypeFailure } = await import('./taskSchedule.js');
    const ledgerEntered = Promise.withResolvers();
    let rejectLedger;
    recordTaskTypeSuccess.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectLedger = reject;
      ledgerEntered.resolve();
    }));
    const completion = finalizeAgent({
      agentId: persistedAgent.id, task: TASK, success: true, exitCode: 0,
      duration: 1000, outputBuffer: '',
    });

    try {
      // Cold finalization can load async dependencies before entering this
      // ledger. Synchronize on that boundary under the test's own deadline.
      expect(await Promise.race([
        ledgerEntered.promise.then(() => 'ledger'),
        completion.then(() => 'completed'),
      ])).toBe('ledger');
      expect(recordTaskTypeSuccess).toHaveBeenCalledWith('example-output-hook', 'app-example');
      expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({ taskOutcome: { status: 'completed', reason: 'The task delivery criteria passed.' } }) }), 'internal');
      expect(processAgentCompletion).not.toHaveBeenCalled();
    } finally {
      // Drain finalization even when an ordering assertion fails, so its
      // pending write cannot escape into another test's mocks or fixtures.
      rejectLedger?.(new Error('ledger write failed'));
      await completion.catch(() => {});
    }

    await expect(completion).resolves.toMatchObject({ success: true });
    expect(recordTaskTypeFailure).not.toHaveBeenCalled();
    expect(processAgentCompletion).toHaveBeenCalledWith(persistedAgent.id, TASK, true, '');
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('ledger write failed'), expect.any(Object));
  });

  it('records an unparseable scheduled output as a failure but excludes ad-hoc and terminated tasks', async () => {
    const { recordTaskTypeSuccess, recordTaskTypeFailure } = await import('./taskSchedule.js');
    hook.mockResolvedValueOnce({ recorded: false, reason: 'unparseable-response' });
    await finalizeAgent({ agentId: persistedAgent.id, task: TASK, success: true, exitCode: 0, duration: 1000, outputBuffer: '' });
    expect(recordTaskTypeFailure).toHaveBeenCalledWith('example-output-hook', 'app-example', { errorCategory: 'unparseable-response' });
    expect(recordTaskTypeSuccess).not.toHaveBeenCalled();

    recordTaskTypeFailure.mockClear();
    await finalizeAgent({ agentId: 'ad-hoc', task: { id: 'ad-hoc-task', taskType: 'user', metadata: {} }, success: true, outputBuffer: '' });
    await finalizeAgent({ agentId: 'terminated', task: TASK, success: false, terminatedByUser: true, outputBuffer: '' });
    expect(recordTaskTypeFailure).not.toHaveBeenCalled();
    expect(recordTaskTypeSuccess).not.toHaveBeenCalled();
  });

  it('persists scanner limits independently of successful assessment delivery and completion replay', async () => {
    const scanner = { version: 1, status: 'time-limit', model: 'example-model', effort: 'low', auth: 'chatgpt',
      maxCostUsd: null, estimatedCostUsd: null, timeLimitSeconds: 600, exitCode: 130,
      artifacts: { findings: true, coverage: false } };
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security', prCompletion: 'draft' } };
    persistedAgent.metadata.executionInterruption = { category: 'content-refusal', source: 'provider' };
    tryReadFile.mockResolvedValueOnce(`Delivered a fix.\nSCANNER_STATUS_JSON: ${JSON.stringify(scanner)}`);
    const args = { agentId: 'agent-scanner', task, success: true, workspacePath: '/worktree' };
    await dispatchTaskOutputHookOnce(args);
    expect(persistedAgent.metadata).toMatchObject({ securityScan: { ...scanner, source: 'agent-report' },
      auditAssessment: { status: 'recorded' }, executionInterruption: { category: 'content-refusal' } });
    await dispatchTaskOutputHookOnce(args);
    expect(persistedAgent.metadata.securityScan.status).toBe('time-limit');
  });

  it("lands the code-quality lane's ranked next audits on the execution record (#12085)", async () => {
    const { recordRecommendedAudits } = await import('./taskSchedule.js');
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'code-quality' } };
    tryReadFile.mockResolvedValueOnce('Filed 2 issues.\n## Recommended next audits\n1. better-structural-drift — drifted registries: server/lib\n2. ux — buried action: client/src\nQUALITY_AUDIT_JSON: {}');
    await dispatchTaskOutputHookOnce({ agentId: 'agent-triage', task, success: true, workspacePath: '/worktree' });
    expect(recordRecommendedAudits).toHaveBeenCalledWith('code-quality', 'app-example', [
      'better-structural-drift — drifted registries: server/lib',
      'ux — buried action: client/src',
    ]);
    expect(persistedAgent.metadata).toMatchObject({ auditAssessment: { status: 'recorded' } });
  });

  it('captures audit telemetry on the shared completion path without waiving fix-mode delivery criteria', async () => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'better-complexity' } };
    await expect(dispatchTaskOutputHookOnce({ agentId: 'agent-audit', task, success: true, workspacePath: '/worktree' }))
      .resolves.toEqual({ ran: false, auditAssessment: { status: 'recorded' } });
    expect(recordAuditQuality).toHaveBeenCalledWith({ task, taskType: 'better-complexity', agentId: 'agent-audit', success: true, workspacePath: '/worktree', assessedAt: persistedAgent.startedAt });
    expect(hook).not.toHaveBeenCalled();
    expect(updateAgent).toHaveBeenCalledWith('agent-audit', { metadata: { auditAssessment: { status: 'recorded' } } });
  });

  it('fails audit delivery with retained actionable rows even when its quality assessment succeeded', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const workspacePath = await mkdtemp(join(tmpdir(), 'audit-disposition-final-'));
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security', auditDispositionVersion: '1' } };
    const report = { version: 1, findings: [{ key: 'example-boundary', title: 'Example authority gap', path: 'server/routes/example.js',
      severity: 8, confidence: 'high', evidence: 'Synthetic mounted request crossed the boundary.', classification: 'actionable',
      disposition: { kind: 'unresolved', reason: 'Issue creation failed: tracker unavailable.' } }] };
    try {
      tryReadFile.mockImplementation(async path => (await import('node:fs/promises')).readFile(path, 'utf8').catch(() => null));
      await writeFile(join(workspacePath, '.agent-done-agent-disposition-final'), JSON.stringify({
        summary: `Delivered a coherent fix.\nAUDIT_FINDINGS_JSON: ${JSON.stringify(report)}`,
      }));
      await finalizeAgent({ agentId: 'agent-disposition-final', task, success: true, exitCode: 0, duration: 1000,
        workspacePath, outputBuffer: 'Completed assessment and one fix' });
      expect(persistedAgent.metadata.auditFindings.report).toEqual(report);
      expect(completeAgent).toHaveBeenCalledWith('agent-disposition-final', expect.objectContaining({
        success: false, auditAssessment: { status: 'recorded' },
        auditDisposition: expect.objectContaining({ status: 'incomplete', unresolved: 1 }),
        completionReason: 'audit-disposition-incomplete',
      }));
      expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'blocked' }), 'internal');
      expect(addTask).not.toHaveBeenCalled();
      // A saved score cannot waive a missing final register on recovery replay.
      await rm(join(workspacePath, '.agent-done-agent-disposition-final'));
      await expect(dispatchRecoveredTaskOutputHook({ agentId: 'agent-disposition-final', task, success: true, workspacePath }))
        .resolves.toMatchObject({ auditDisposition: { status: 'incomplete', unresolved: 1 } });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
      tryReadFile.mockReset();
    }
  });

  it('saves the assessment when scanner diagnostic persistence fails', async () => {
    const scanner = { version: 1, status: 'time-limit', model: null, effort: null, auth: 'unknown',
      maxCostUsd: null, estimatedCostUsd: null, timeLimitSeconds: 600, exitCode: null,
      artifacts: { findings: null, coverage: null } };
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security', prCompletion: 'draft' } };
    tryReadFile.mockResolvedValueOnce(`SCANNER_STATUS_JSON: ${JSON.stringify(scanner)}`);
    updateAgent.mockRejectedValueOnce(new Error('diagnostic storage unavailable'));
    await expect(dispatchTaskOutputHookOnce({ agentId: 'agent-diagnostic-failure', task, success: true, workspacePath: '/worktree' }))
      .resolves.toMatchObject({ auditAssessment: { status: 'recorded' } });
    expect(recordAuditQuality).toHaveBeenCalledWith(expect.objectContaining({ task, success: true }));
    expect(persistedAgent.metadata.auditAssessment).toEqual({ status: 'recorded' });
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Scanner diagnostics were not saved'), expect.any(Object));
  });

  // Landing the app's `.quality.json` PR is opt-in and runs outside the request
  // lifecycle, so it must never fire for an un-opted app nor fail a completion.
  // Each dispatch needs its own agent id — dispatchTaskOutputHookOnce caches by id.
  it.each(['draft', 'leave-open'])('retains measurements without publishing snapshots for %s, on completion', async prCompletion => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security', prCompletion } };
    appsRegistry.getAppById.mockResolvedValue({ id: 'app-example', repoPath: '/repo', publishQualitySnapshot: true });
    snapshotFile.publishAppQualitySnapshot.mockClear();
    await dispatchTaskOutputHookOnce({ agentId: `review-only-${prCompletion}`, task, success: true, workspacePath: '/worktree' });
    expect(recordAuditQuality).toHaveBeenCalledWith(expect.objectContaining({ task, success: true }));
    expect(snapshotFile.publishAppQualitySnapshot).not.toHaveBeenCalled();
    await dispatchRecoveredTaskOutputHook({ agentId: persistedAgent.id, task, success: true });
    expect(snapshotFile.publishAppQualitySnapshot).not.toHaveBeenCalled();
  });

  it('commits a repo snapshot only for an opted-in app that just recorded a measurement', async () => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'better-complexity' } };
    let run = 0;
    const dispatch = () => { persistedAgent.metadata = {}; return dispatchTaskOutputHookOnce({ agentId: `agent-snapshot-${run += 1}`, task, success: true, workspacePath: '/worktree' }); };
    const optedIn = { id: 'app-example', repoPath: '/repo/example-app', publishQualitySnapshot: true };

    appsRegistry.getAppById.mockResolvedValue(optedIn);
    await expect(dispatch()).resolves.toEqual({ ran: false, auditAssessment: { status: 'recorded' } });
    expect(snapshotFile.publishAppQualitySnapshot).toHaveBeenCalledWith(optedIn);

    for (const app of [{ ...optedIn, publishQualitySnapshot: false }, { ...optedIn, publishQualitySnapshot: 'true' },
      { id: 'app-example' }, null]) {
      snapshotFile.publishAppQualitySnapshot.mockClear();
      appsRegistry.getAppById.mockResolvedValue(app);
      await dispatch();
      expect(snapshotFile.publishAppQualitySnapshot).not.toHaveBeenCalled();
    }

    // A missing or invalid report records nothing, so there is nothing new to publish.
    appsRegistry.getAppById.mockResolvedValue(optedIn);
    recordAuditQuality.mockResolvedValueOnce(false);
    await dispatch();
    expect(snapshotFile.publishAppQualitySnapshot).not.toHaveBeenCalled();

    // A locked index or an unreadable registry must not fail the completion.
    snapshotFile.publishAppQualitySnapshot.mockRejectedValueOnce(new Error('index.lock exists'));
    await expect(dispatch()).resolves.toEqual({ ran: false, auditAssessment: { status: 'recorded' } });
    appsRegistry.getAppById.mockRejectedValueOnce(new Error('registry unreadable'));
    await expect(dispatch()).resolves.toEqual({ ran: false, auditAssessment: { status: 'recorded' } });
    for (const reason of ['index.lock exists', 'registry unreadable']) {
      expect(emitLog).toHaveBeenCalledWith('error', `❌ Quality snapshot publish failed for app app-example: ${reason}`, { appId: 'app-example' });
    }
  });

  it('records assessment failure independently and allows recovery to persist it later', async () => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security' } };
    recordAuditQuality.mockRejectedValueOnce(new Error('storage unavailable'));
    const first = await dispatchTaskOutputHookOnce({ agentId: 'audit-recovery', task, success: true, workspacePath: '/worktree' });
    expect(first).toEqual({ ran: false, auditAssessment: { status: 'persistence-failed' } });
    expect(persistedAgent.metadata.auditAssessment.status).toBe('persistence-failed');
    await expect(dispatchRecoveredTaskOutputHook({ agentId: 'audit-recovery', task, success: true, workspacePath: '/worktree' }))
      .resolves.toEqual({ ran: false, auditAssessment: { status: 'recorded' } });
    expect(persistedAgent.metadata.auditAssessment.status).toBe('recorded');
    recordAuditQuality.mockClear();
    await dispatchRecoveredTaskOutputHook({ agentId: 'audit-recovery', task, success: true });
    expect(recordAuditQuality).not.toHaveBeenCalled();
  });

  it('retains a saved result when an older failure marker survived a metadata write error', async () => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security' } };
    persistedAgent.metadata.auditAssessment = { status: 'persistence-failed' };
    persistedAgent.result = { auditAssessment: { status: 'recorded' } };
    await expect(dispatchRecoveredTaskOutputHook({ agentId: 'saved-result', task, success: true }))
      .resolves.toEqual({ ran: false, auditAssessment: { status: 'recorded' } });
    expect(recordAuditQuality).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves legacy learning results while enforcing explicit delivery=%s', async explicit => {
    isProgrammaticIoTaskType.mockImplementation(type => type !== 'security');
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security' } };
    recordAuditQuality.mockResolvedValueOnce(false);
    await finalizeAgent({ agentId: 'audit-final', task, success: true, exitCode: 0, duration: 1000,
      workspacePath: '/missing-audit-worktree', startedAt: Date.now() - 1000, outputBuffer: 'Audit complete',
      finalSummary: explicit ? JSON.stringify({ summary: 'Invented audit report.', taskOutcome: { status: 'completed', reason: 'Invented completion claim.' } }) : null });
    expect(completeAgent).toHaveBeenCalledWith('audit-final', expect.objectContaining({
      success: !explicit, executionSuccess: true, validationPassed: false,
      taskOutcome: explicit ? { status: 'incomplete', reason: 'Delivery checks did not pass.' } : null, auditAssessment: { status: 'not-recorded' },
    }));
    isProgrammaticIoTaskType.mockReturnValue(true);
  });

  it('keeps exact large ingestion and replay bytes in run artifacts rather than hot agent metadata', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { readCompletionData } = await import('./agentCompletionData.js');
    const workspacePath = await mkdtemp(join(tmpdir(), 'completion-large-ingestion-'));
    const payload = 'payload-'.repeat(150000);
    const outputBuffer = 'provider-output-'.repeat(100000);
    const sentinel = JSON.stringify({ summary: 'Delivered.', payload });
    try {
      await writeFile(join(workspacePath, '.agent-done-agent-example'), sentinel);
      await finalizeAgent({ agentId: 'agent-example', task: { ...TASK, prompt: payload, history: payload },
        success: true, exitCode: 0, duration: 1000, workspacePath, outputBuffer });
      expect(JSON.stringify(persistedAgent.metadata).length).toBeLessThan(15000);
      expect(JSON.parse(JSON.stringify(persistedAgent.metadata))).not.toHaveProperty('completionSentinelContents');
      expect(JSON.parse(JSON.stringify(persistedAgent.metadata.completionCleanup))).not.toHaveProperty('context');
      expect(await readCompletionData(persistedAgent, persistedAgent.metadata.completionSentinelData)).toBe(sentinel);
      const replay = await readCompletionData(persistedAgent, persistedAgent.metadata.completionCleanup.replay);
      expect(replay.outputBuffer).toBe(outputBuffer);
      expect(replay.task.id).toBe(TASK.id);
      expect(replay.task).not.toHaveProperty('prompt');
      expect(replay.task).not.toHaveProperty('history');
      await expect(readCompletionData({ ...persistedAgent, startedAt: '2020-01-01T00:00:00Z' },
        persistedAgent.metadata.completionCleanup.replay)).rejects.toThrow('completion-data-run-changed');
    } finally { await rm(workspacePath, { recursive: true, force: true }); }
  });

  it.each([
    ['markdown checkpoint', 'Reviewed this batch. Deep coverage remains incomplete.', 'Reviewed this batch. Deep coverage remains incomplete.'],
    ['structured checkpoint', JSON.stringify({ summary: 'Saved a partial checkpoint.', payload: null }), 'Saved a partial checkpoint.'],
    ['missing summary', null, null],
    ['terminal result fallback', null, 'Explicit terminal result.', 'Explicit terminal result.'],
    ['sentinel precedence', 'Saved checkpoint.', 'Saved checkpoint.', 'Provider terminal response.'],
    ['fenced valid envelope', '```json\n{"summary":"Fenced completion."}\n```', 'Fenced completion.'],
    ['fenced malformed envelope', '```json\n{"summary":\n```', null],
    ['malformed envelope', '{"summary":', null],
    ['invalid summary', JSON.stringify({ summary: { text: 'not a string' } }), null],
  ])('persists only explicit completion text for a resumed Deep %s', async (_label, sentinel, expected, finalSummary = null) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const workspacePath = await mkdtemp(join(tmpdir(), 'completion-summary-'));
    try {
      if (sentinel !== null) await writeFile(join(workspacePath, '.agent-done-summary-example'), sentinel);
      const task = { ...TASK, metadata: { ...TASK.metadata, auditDepth: 'deep', simplify: false } };
      await finalizeAgent({ agentId: 'summary-example', task, success: true, exitCode: 0,
        duration: 1000, workspacePath, finalSummary, outputBuffer: 'Thinking: inspect files\nexec\npython command output' });
      expect(persistedAgent.metadata.taskSummary).toBe(expected);
      expect(persistedAgent.metadata.simplifySummary).toBeNull();
      expect(deep.checkpointDeepAudit).toHaveBeenCalled();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it.each(['blocked', 'incomplete', 'completed', 'no-action-needed'])('persists explicit %s delivery independently of a zero exit', async (status) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const workspacePath = await mkdtemp(join(tmpdir(), 'task-outcome-'));
    const taskOutcome = { status, reason: 'Invented prerequisite or delivery evidence.' };
    const held = ['blocked', 'incomplete'].includes(status);
    const task = { ...TASK, metadata: { ...TASK.metadata } };
    try {
      await writeFile(join(workspacePath, '.agent-done-agent-example'), JSON.stringify({ summary: 'Invented final report.', taskOutcome, payload: { result: 'example' } }));
      const result = await finalizeAgent({ agentId: 'agent-example', runId: 'run-example', task, success: true,
        exitCode: 0, duration: 1000, workspacePath, outputBuffer: '' });
      expect(result).toMatchObject({ success: !held, taskOutcome });
      expect(completeAgent).toHaveBeenCalledWith('agent-example', expect.objectContaining({ executionSuccess: true, success: !held, taskOutcome }));
      expect(completeAgentRun).toHaveBeenCalledWith('run-example', '', 0, 1000, held ? expect.objectContaining({ category: `task-${status}` }) : undefined, held ? false : null, { executionSuccess: true, taskOutcome });
      expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: held ? 'in_progress' : 'completed', metadata: expect.objectContaining({ taskOutcome }) }), task.taskType);
      expect(persistedAgent.metadata.taskOutcome).toEqual(taskOutcome);
      expect(processAgentCompletion).toHaveBeenCalledWith('agent-example', task, !held, '');
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  const reviewTask = () => ({ id: TASK.id, taskType: 'internal', status: 'in_progress', metadata: {
    reviewLoopFollowUp: true, reviewLoopPRUrl: 'https://github.com/atomantic/PortOS/pull/123',
    reviewLoopPRBranch: 'fix/example', failureCount: 2,
  } });

  it.each(['normal', 'restart'])('completes a verified merged review target without retrying during %s completion', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    mergedTarget.getOriginInfo.mockResolvedValue({ host: 'github.com', fullName: 'atomantic/PortOS' });
    mergedTarget.probeChangeRequestState.mockResolvedValue({ readable: true, prState: 'MERGED' });
    const task = reviewTask();
    const reported = { status: mode === 'normal' ? 'blocked' : 'incomplete', reason: 'The target is merged; corrections are tracked separately and the checkout is preserved.' };
    persistedAgent.metadata.workspacePath = '/example/repo';
    persistedAgent.metadata.taskOutcome = reported;
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    const result = mode === 'normal'
      ? await finalizeAgent({ agentId: 'agent-example', runId: 'run-example', task, success: true,
        exitCode: 0, duration: 1000, workspacePath: '/example/repo', outputBuffer: '',
        finalSummary: JSON.stringify({ summary: reported.reason, taskOutcome: reported }) })
      : await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0, duration: 1000 });
    expect(mergedTarget.probeChangeRequestState).toHaveBeenCalledWith('/example/repo', { number: 123, branch: 'fix/example' });
    expect(result).toMatchObject({ success: true, taskOutcome: { status: 'no-action-needed' } });
    if (mode === 'normal') expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'completed',
      metadata: expect.objectContaining({ failureCount: 2, taskOutcome: expect.objectContaining({ status: 'no-action-needed' }) }) }), 'internal');
    expect(completeAgent).toHaveBeenCalledWith('agent-example', expect.objectContaining({ success: true, validationPassed: true,
      taskOutcome: expect.objectContaining({ status: 'no-action-needed' }) }));
    expect(persistedAgent.metadata).toMatchObject({ taskOutcomeSource: 'forge-verification', reportedTaskOutcome: reported });
    expect(resolveFailedTaskUpdate).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    if (mode === 'normal') expect(processAgentCompletion).toHaveBeenCalledWith('agent-example', task, true, '');
    else expect(result.deliveryHeld).toBe(false);
  });

  it.each([
    { name: 'an open target', state: { readable: true, prState: 'OPEN' } },
    { name: 'a closed unmerged target', state: { readable: true, prState: 'CLOSED' } },
    { name: 'an unreadable target', state: { readable: false, prState: null } },
    { name: 'a different repository', meta: { reviewLoopPRUrl: 'https://github.com/another/project/pull/123' } },
    { name: 'a leave-open policy', meta: { reviewLoopLeaveOpen: true } },
    { name: 'an ordinary task', meta: { reviewLoopFollowUp: false } },
    { name: 'a failed process', execution: { success: false, exitCode: 1 } },
    { name: 'a provider safety refusal', execution: { executionInterruption: { category: 'content-refusal' } } },
  ])('does not replace a blocked outcome for $name', async ({ state, meta, execution }) => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    mergedTarget.getOriginInfo.mockResolvedValue({ host: 'github.com', fullName: 'atomantic/PortOS' });
    mergedTarget.probeChangeRequestState.mockResolvedValue(state || { readable: true, prState: 'MERGED' });
    const task = reviewTask();
    Object.assign(task.metadata, meta);
    const reported = { status: 'blocked', reason: 'An unmet prerequisite remains.' };
    const result = await finalizeAgent({ agentId: 'agent-example', task, success: true, exitCode: 0,
      duration: 1000, workspacePath: '/example/repo', outputBuffer: '', ...execution,
      finalSummary: JSON.stringify({ summary: reported.reason, taskOutcome: reported }) });
    expect(result).toMatchObject({ success: false, taskOutcome: reported });
    expect(updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'completed' }), 'internal');
  });

  it('retains explicit approval with choices instead of retrying', async () => {
    const taskOutcome = { status: 'blocked', reason: 'Continuing would exceed the authorized budget.',
      recovery: { mode: 'approval', options: ['Increase the budget and retry.', 'Keep the work stopped.'] } };
    await finalizeAgent({ agentId: 'agent-example', task: TASK, success: true, exitCode: 0,
      finalSummary: JSON.stringify({ summary: 'Budget decision needed.', taskOutcome }) });
    expect(updateTask).toHaveBeenLastCalledWith(TASK.id, expect.objectContaining({ status: 'blocked',
      metadata: expect.objectContaining({ blockedCategory: 'task-approval',
        blockedReason: expect.stringContaining('1. Increase the budget and retry.') }) }), TASK.taskType);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('persists the LI execution verdict in the same public completion task write', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { ...TASK, metadata: { ...TASK.metadata, liProposal: {
      appId: 'app-example', slug: 'example-proposal', scope: 'repo',
    } } };
    await finalizeAgent({ agentId: persistedAgent.id, task, success: true, exitCode: 0, outputBuffer: '' });
    expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({
      liExecution: expect.objectContaining({ appId: 'app-example', slug: 'example-proposal', success: true }),
    }) }), 'internal');
  });

  it.each(['normal', 'recovered'])('keeps unfinished inline release delivery on the same task after %s completion', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    inlineReleaseVerification.mockResolvedValueOnce({ verified: false, reason: 'synchronization-pr-not-merged' });
    const task = { ...TASK, status: 'in_progress', metadata: { analysisType: 'do-release', app: 'app-example' } };
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.releasePublication = { synchronizationHandoffVersion: 2 };
    const result = mode === 'normal'
      ? await finalizeAgent({ agentId: persistedAgent.id, task, success: true, exitCode: 0, outputBuffer: '' })
      : await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0 });
    expect(result).toMatchObject({ success: false, taskOutcome: { status: 'incomplete',
      reason: expect.stringContaining('synchronization-pr-not-merged') } });
    expect(completeAgent).toHaveBeenCalledWith(persistedAgent.id, expect.objectContaining({ success: false }));
    expect(updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'completed' }), task.taskType);
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['normal', 'recovered'])('durably parks a typed investigation dependency before %s terminal publication without claiming success', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const service = await import('./investigationDependencyWait.js');
    const task = { ...TASK, status: 'in_progress', metadata: { isInvestigation: true,
      blockedSystemRecovery: true, preserveOriginalBudget: true, failureCount: 2, totalSpawnCount: 2 } };
    const taskOutcome = { status: 'incomplete', reason: 'An existing local owner is fixing the root code.',
      recovery: { mode: 'dependency-wait', ownerTaskId: 'sys-owner', ownerAgentId: 'agent-owner',
        prUrl: 'https://github.com/example/repo/pull/7' } };
    const context = { expectedStatus: 'in_progress', expectedTask: {
      description: task.description, priority: task.priority, metadata: task.metadata } };
    const resolve = vi.spyOn(service, 'resolveInvestigationDependencyUpdate').mockResolvedValue({ status: 'blocked',
      dependencyWaitContext: context, metadata: { ...task.metadata, taskOutcome, blockedCategory: 'internal-dependency',
        blockedReason: 'Waiting for independently verified delivery.' } });
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.taskOutcome = taskOutcome;
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    const order = [];
    updateTask.mockImplementationOnce(async () => { order.push('durable-wait'); return { status: 'blocked' }; });
    completeAgent.mockImplementationOnce(async () => { order.push('terminal'); return null; });
    try {
      const result = mode === 'normal'
        ? await finalizeAgent({ agentId: persistedAgent.id, task, success: true, exitCode: 0,
          finalSummary: JSON.stringify({ summary: taskOutcome.reason, taskOutcome }) })
        : await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0 });
      expect(result).toMatchObject({ success: false, taskOutcome });
      expect(order).toEqual(['durable-wait', 'terminal']);
      expect(resolve).toHaveBeenCalledWith(task, taskOutcome, persistedAgent.id);
      expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'blocked', metadata: expect.objectContaining({
        blockedCategory: 'internal-dependency', failureCount: 2, totalSpawnCount: 2,
      }) }), 'internal', expect.objectContaining(context));
      expect(completeAgent).toHaveBeenCalledWith(persistedAgent.id, expect.objectContaining({ success: false }));
      expect(addTask).not.toHaveBeenCalled();
      expect(resolveFailedTaskUpdate).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });

  it.each(['normal', 'recovered'])('parks a runtime prerequisite through %s public completion without a provider retry', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: TASK.id, taskType: 'internal', status: 'in_progress', metadata: {
      isInvestigation: true, totalSpawnCount: 3, failureCount: 1, lastSpawnedAt: '2026-09-10T00:00:00Z',
    } };
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.completionTaskDispatch = { taskId: task.id, taskType: 'internal',
      expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, task.metadata[key] ?? null]) };
    getTaskById.mockResolvedValueOnce(task);
    mergedTarget.getOriginInfo.mockResolvedValue({ isGithub: true, host: 'github.com', fullName: 'example/PortOS' });
    const github = await import('./github.js');
    const git = await import('../lib/execGit.js');
    const forge = vi.spyOn(github, 'execGh').mockImplementation(async args => JSON.stringify(args[0] === 'pr'
      ? { state: 'MERGED', url: 'https://github.com/example/PortOS/pull/123', headRefOid: 'a'.repeat(40), mergeCommit: { oid: 'c'.repeat(40) }, baseRefName: 'main' }
      : { defaultBranchRef: { name: 'main' } }));
    const gitRead = vi.spyOn(git, 'execGit').mockResolvedValue({ stdout: 'd'.repeat(40), exitCode: 0 });
    const taskOutcome = { status: 'blocked', reason: 'Update preflight refuses this active investigation; boot is stale.',
      recovery: { mode: 'runtime', prUrl: 'https://github.com/example/PortOS/pull/123', requiredCommit: 'a'.repeat(40) } };
    try {
      persistedAgent.metadata.taskOutcome = taskOutcome;
      persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
      const order = [];
      updateTask.mockImplementationOnce(async () => { order.push('prerequisite'); return {}; });
      completeAgent.mockImplementationOnce(async () => { order.push('terminal'); return null; });
      // The dispatcher increments counters after the agent receives this snapshot.
      const staleTask = { ...task, status: 'pending', metadata: { ...task.metadata, totalSpawnCount: 2, lastSpawnedAt: undefined } };
      const result = mode === 'normal'
        ? await finalizeAgent({ agentId: persistedAgent.id, task: staleTask, success: true, exitCode: 0,
          finalSummary: JSON.stringify({ summary: taskOutcome.reason, taskOutcome }) })
        : await retireDeadAgent({ agent: persistedAgent, task: staleTask, success: true, exitCode: 0 });
      expect(result).toMatchObject({ success: false, taskOutcome });
      expect(order).toEqual(['prerequisite', 'terminal']);
      expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'blocked', metadata: expect.objectContaining({
        blockedCategory: 'runtime-verification', failureCount: 1, totalSpawnCount: 3,
        runtimeVerification: expect.objectContaining({ taskId: task.id, agentId: persistedAgent.id, integratedCommit: 'c'.repeat(40) }),
      }) }), 'internal', expect.objectContaining({ expectedStatus: 'in_progress' }));
      expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'blocked' }), 'internal', {
        expectedStatus: 'in_progress',
        expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
        recoveryOwner: { id: persistedAgent.id, startedAt: persistedAgent.startedAt },
        expectedMetadata: { claimedBy: task.metadata.claimedBy, claimedAt: task.metadata.claimedAt,
          lastSpawnedAt: task.metadata.lastSpawnedAt, totalSpawnCount: task.metadata.totalSpawnCount },
      });
      expect(completeAgent).toHaveBeenCalledWith(persistedAgent.id, expect.objectContaining({ success: false, deliveryRecoveryOwned: true }));
      expect(resolveFailedTaskUpdate).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled();
    } finally { forge.mockRestore(); gitRead.mockRestore(); }
  });

  it.each(['normal', 'recovered'])('preserves the bounded already-running decision through %s completion and interrupted replay', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: TASK.id, taskType: 'internal', status: 'in_progress', metadata: {
      totalSpawnCount: 3, failureCount: 2, lastSpawnedAt: '2026-09-10T00:00:00Z',
    } };
    let live = structuredClone(task);
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.runId = 'run-example';
    persistedAgent.metadata.completionTaskDispatch = { taskId: task.id, taskType: 'internal',
      expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, task.metadata[key] ?? null]) };
    getTaskById.mockImplementation(async () => live);
    updateTask.mockImplementation(async (_id, update) => {
      live = { ...live, ...update, metadata: { ...live.metadata, ...update.metadata } };
      return live;
    });
    mergedTarget.getOriginInfo.mockResolvedValue({ isGithub: true, host: 'github.com', fullName: 'example/PortOS' });
    const github = await import('./github.js');
    const git = await import('../lib/execGit.js');
    const boot = await import('./installState.js');
    const forge = vi.spyOn(github, 'execGh').mockImplementation(async args => JSON.stringify(args[0] === 'pr'
      ? { state: 'MERGED', url: 'https://github.com/example/PortOS/pull/123', headRefOid: 'a'.repeat(40), mergeCommit: { oid: 'c'.repeat(40) }, baseRefName: 'main' }
      : { defaultBranchRef: { name: 'main' } }));
    const gitRead = vi.spyOn(git, 'execGit').mockResolvedValue({ stdout: 'd'.repeat(40), exitCode: 0 });
    const taskOutcome = { status: 'blocked', reason: 'Retirement remains unverified.',
      recovery: { mode: 'runtime', prUrl: 'https://github.com/example/PortOS/pull/123', requiredCommit: 'a'.repeat(40) } };
    boot.__setBootCommitForTest('c'.repeat(40));
    try {
      persistedAgent.metadata.taskOutcome = taskOutcome;
      persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
      if (mode === 'recovered') {
        completeAgent.mockRejectedValueOnce(new Error('interrupted terminal write'));
        await expect(retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0 }))
          .rejects.toThrow('interrupted terminal write');
        expect(live.metadata.failureCount).toBe(3);
      }
      const result = mode === 'normal'
        ? await finalizeAgent({ agentId: persistedAgent.id, runId: 'run-example', task, success: true, exitCode: 0,
          finalSummary: JSON.stringify({ summary: taskOutcome.reason, taskOutcome }) })
        : await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0 });
      expect(result).toMatchObject({ success: false, taskOutcome: { reason: expect.stringContaining('already running') } });
      expect(result.taskOutcome).not.toHaveProperty('recovery');
      expect(live).toMatchObject({ status: 'blocked', metadata: { blockedCategory: 'task-recovery-exhausted',
        failureCount: 3, totalSpawnCount: 3, runtimeVerification: { status: 'satisfied' } } });
      expect(live.metadata.taskOutcome).toEqual(result.taskOutcome);
      expect(completeAgent).toHaveBeenLastCalledWith(persistedAgent.id, expect.objectContaining({ taskOutcome: result.taskOutcome }));
      const runWrites = completeAgentRun.mock.calls.filter(args => args[0] === 'run-example');
      expect(runWrites.length).toBeGreaterThan(0);
      for (const args of runWrites) expect(args.at(-1).taskOutcome).toEqual(result.taskOutcome);
      expect(addTask).not.toHaveBeenCalled();
    } finally { boot.__setBootCommitForTest(null); forge.mockRestore(); gitRead.mockRestore(); }
  });

  it('stops recovered runtime finalization when its conditional prerequisite write loses ownership', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: TASK.id, taskType: 'internal', status: 'in_progress', metadata: { totalSpawnCount: 1 } };
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.completionTaskDispatch = { taskId: task.id, taskType: 'internal',
      expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, task.metadata[key] ?? null]) };
    getTaskById.mockResolvedValueOnce(task);
    persistedAgent.metadata.taskOutcome = { status: 'blocked', reason: 'The running fix remains unverified.',
      recovery: { mode: 'runtime', prUrl: 'https://github.com/example/PortOS/pull/123', requiredCommit: 'a'.repeat(40) } };
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    updateTask.mockResolvedValueOnce({ statusChanged: true });
    await expect(retireDeadAgent({ agent: persistedAgent, task,
      success: true, exitCode: 0 })).rejects.toThrow('task ownership changed');
    expect(completeAgent).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['worktree', 'pinned-claim'])('normalizes %s cleanup-only work on successful execution to completed', async mode => {
    const taskOutcome = { status: 'incomplete', reason: 'Verified delivery; owner still holds checkout.', recovery: { mode: 'cleanup' } };
    isProgrammaticIoTaskType.mockReturnValue(false);
    persistedAgent.metadata = mode === 'worktree' ? { isWorktree: true }
      : { isWorktree: false, claimPicksOwnBranch: false, claimBranch: 'claim/issue-42', claimBranches: ['claim/issue-42'] };
    try {
      await finalizeAgent({ agentId: 'agent-example', task: { id: TASK.id, taskType: 'user', metadata: {} },
        success: true, exitCode: 0, finalSummary: JSON.stringify({ summary: 'Cleanup handed off.', taskOutcome }) });
      expect(updateTask).toHaveBeenLastCalledWith(TASK.id, expect.objectContaining({ status: 'completed',
        metadata: expect.objectContaining({ taskOutcome: { status: 'completed', reason: taskOutcome.reason } }) }), 'user');
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({ success: true }));
      expect(addTask).not.toHaveBeenCalled();
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it('records successful execution with a timestamp fence while cleanup remains pending', async () => {
    const { recordTaskTypeFailure, recordTaskTypeSuccess } = await import('./taskSchedule.js');
    const taskOutcome = { status: 'incomplete', reason: 'Only checkout retirement remains.', recovery: { mode: 'cleanup' } };
    isProgrammaticIoTaskType.mockReturnValue(false);
    persistedAgent.metadata = { isWorktree: true };
    const completedAt = '2026-10-28T10:00:00.000Z';
    completeAgent.mockResolvedValueOnce({ completedAt, result: { cleanupPending: true, taskOutcome } });
    try {
      await finalizeAgent({ agentId: 'agent-example', task: TASK, success: true, exitCode: 0,
        finalSummary: JSON.stringify({ summary: 'Cleanup retained.', taskOutcome }) });
      expect(recordTaskTypeFailure).not.toHaveBeenCalled();
      expect(recordTaskTypeSuccess).toHaveBeenCalledWith('example-output-hook', 'app-example', { notAfter: completedAt });
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it('keeps a replayed finalize of its own cleanup handoff pending and recovery-owned', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    persistedAgent.metadata = { isWorktree: true };
    const task = { ...TASK, status: 'in_progress', metadata: { ...TASK.metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-example' } };
    try {
      await finalizeAgent({ agentId: 'agent-example', task, success: true, exitCode: 0, outputBuffer: '' });
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({
        deliveryRecoveryOwned: true, cleanupPending: true }));
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it('fails a cleanly exited run the provider refused and records the interruption', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    try {
      await finalizeAgent({ agentId: 'agent-example', task: { id: TASK.id, taskType: 'user', metadata: {} },
        success: true, exitCode: 0, outputBuffer: '',
        errorAnalysis: { category: 'content-refusal', origin: 'provider', permanent: true, actionable: false } });
      expect(persistedAgent.metadata.executionInterruption).toEqual({ category: 'content-refusal', source: 'provider' });
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({ success: false }));
      expect(updateTask).not.toHaveBeenCalledWith(TASK.id, expect.objectContaining({ status: 'completed' }), 'user');
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it.each(['saved', 'pinned-claim'])('retains a %s cleanup handoff when its run is recovered after a crash', async mode => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const workspacePath = await mkdtemp(join(tmpdir(), 'cleanup-restart-'));
    isProgrammaticIoTaskType.mockReturnValue(false);
    const taskOutcome = { status: 'incomplete', reason: 'Only preservation remains.', recovery: { mode: 'cleanup' } };
    const task = { ...TASK, status: 'in_progress', description: 'Preserve the delivered checkout.', priority: 'MEDIUM', metadata: { ...TASK.metadata, ...(mode === 'saved'
      ? { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-example' } : {}) } };
    persistedAgent.metadata = { workspacePath, ...(mode === 'saved' ? { isWorktree: true }
      : { isWorktree: false, claimPicksOwnBranch: false, claimBranch: 'claim/issue-42', claimBranches: ['claim/issue-42'] }) };
    try {
      await writeFile(join(workspacePath, '.agent-done-agent-example'), JSON.stringify({ taskOutcome }));
      await retireDeadAgent({ agent: persistedAgent, task, success: mode === 'pinned-claim', exitCode: mode === 'pinned-claim' ? 0 : 1, duration: 1000 });
      expect(updateTask).toHaveBeenLastCalledWith(TASK.id, expect.objectContaining({ status: 'in_progress',
        metadata: expect.objectContaining({ deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-example' }) }), TASK.taskType, {
        expectedStatus: 'in_progress',
        expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
        recoveryOwner: { id: 'agent-example', startedAt: '2026-09-10T00:00:00Z' },
      });
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({ success: false, cleanupPending: true }));
    } finally {
      isProgrammaticIoTaskType.mockReturnValue(true);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('stops repeated delivery recovery at the existing budget with concrete choices', async () => {
    const taskOutcome = { status: 'incomplete', reason: 'Validation remains red.' };
    await finalizeAgent({ agentId: 'agent-example', task: { ...TASK, metadata: { ...TASK.metadata, failureCount: MAX_TASK_RETRIES - 1 } },
      success: true, exitCode: 0, finalSummary: JSON.stringify({ summary: 'Retained failed work.', taskOutcome }) });
    expect(updateTask).toHaveBeenLastCalledWith(TASK.id, expect.objectContaining({ status: 'blocked',
      metadata: expect.objectContaining({ blockedCategory: 'task-recovery-exhausted',
        blockedReason: expect.stringContaining('Options:') }) }), TASK.taskType);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('stops incomplete delivery when the current dispatch spent the last spawn', async () => {
    const taskOutcome = { status: 'incomplete', reason: 'Validation remains unfinished.' };
    await finalizeAgent({ agentId: 'agent-example', task: { ...TASK, metadata: { ...TASK.metadata, totalSpawnCount: 5, failureCount: 0 } },
      success: true, exitCode: 0, finalSummary: JSON.stringify({ summary: 'Retained unfinished work.', taskOutcome }) });
    expect(updateTask).toHaveBeenLastCalledWith(TASK.id, expect.objectContaining({ status: 'blocked',
      metadata: expect.objectContaining({ totalSpawnCount: 5, failureCount: 1, blockedCategory: 'task-recovery-exhausted' }) }), TASK.taskType);
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['normal', 'restart'].flatMap(mode => ['not-planned', 'operator-closed'].map(disposition => [mode, disposition])))
  ('settles a selected claim no-op during %s completion from a verified %s disposition', async (mode, disposition) => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: 'claim-example', taskType: 'user', metadata: { app: 'app-example', claimFlow: true, claimTarget: '42' } };
    const taskOutcome = { status: 'no-action-needed', reason: 'Selected issue no longer requires a change.' };
    const claimDisposition = { status: 'verified', taskId: task.id, issues: [{ issue: 42, disposition }] };
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.taskOutcome = taskOutcome;
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    claimVerifier.verifyClaimDisposition.mockResolvedValue(claimDisposition);
    try {
      if (mode === 'normal') await finalizeAgent({ agentId: persistedAgent.id, task, success: true, exitCode: 0,
        finalSummary: JSON.stringify({ summary: 'Claim stood down.', taskOutcome }) });
      else await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0, duration: 100 });
      expect(claimVerifier.verifyClaimDisposition).toHaveBeenLastCalledWith(expect.objectContaining({ task,
        agent: expect.objectContaining({ id: persistedAgent.id, taskId: task.id }), reportedOutcome: taskOutcome, success: true }));
      expect(completeAgent).toHaveBeenLastCalledWith(persistedAgent.id, expect.objectContaining({ success: true,
        validationPassed: true, taskOutcome, claimDisposition }));
      expect(hook).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled();
      if (mode === 'normal') expect(updateTask).toHaveBeenLastCalledWith(task.id,
        expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({ taskOutcome }) }), task.taskType);
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it.each(['normal', 'restart'])('keeps an unreadable tracker unverified during %s completion even with a saved validation pass', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: 'claim-example', taskType: 'user', metadata: { app: 'app-example', claimFlow: true, claimTarget: '42' } };
    const taskOutcome = { status: 'no-action-needed', reason: 'Agent says done.' };
    persistedAgent.taskId = task.id;
    persistedAgent.result = { validationPassed: true };
    persistedAgent.metadata.taskOutcome = taskOutcome;
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    claimVerifier.verifyClaimDisposition.mockRejectedValue(new Error('Invented forge outage'));
    try {
      if (mode === 'normal') await finalizeAgent({ agentId: persistedAgent.id, task, success: true, exitCode: 0,
        finalSummary: JSON.stringify({ summary: 'Claim stood down.', taskOutcome }) });
      else await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0, duration: 100 });
      expect(completeAgent).toHaveBeenLastCalledWith(persistedAgent.id, expect.objectContaining({ success: false,
        validationPassed: null, taskOutcome: { status: 'incomplete', reason: 'The reported no-action-needed result was not verified.' },
        claimDisposition: { status: 'unverified', reason: 'tracker-unavailable' } }));
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it.each(['normal', 'restart'])('settles an operator-parked claim during %s completion without retrying the blocked report', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: 'claim-example', taskType: 'user', metadata: { claimFlow: true, claimTarget: '42', failureCount: 0 } };
    const reported = { status: 'blocked', reason: 'The selected issue awaits new evidence; no actionable work remains.' };
    const claimDisposition = { status: 'verified', taskId: task.id, issues: [{ issue: 42, disposition: 'operator-blocked' }] };
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.taskOutcome = reported;
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    claimVerifier.verifyClaimDisposition.mockResolvedValue(claimDisposition);
    try {
      if (mode === 'normal') await finalizeAgent({ agentId: persistedAgent.id, task, success: true, exitCode: 0,
        finalSummary: JSON.stringify({ summary: reported.reason, taskOutcome: reported }) });
      else await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0, duration: 100 });
      expect(completeAgent).toHaveBeenLastCalledWith(persistedAgent.id, expect.objectContaining({ success: true,
        validationPassed: true, taskOutcome: expect.objectContaining({ status: 'no-action-needed' }), claimDisposition }));
      expect(persistedAgent.metadata).toMatchObject({ taskOutcomeSource: 'forge-verification', reportedTaskOutcome: reported });
      expect(resolveFailedTaskUpdate).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled();
      if (mode === 'normal') expect(updateTask).toHaveBeenLastCalledWith(task.id,
        expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({ failureCount: 0 }) }), task.taskType);
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it.each(['normal', 'restart'])('preserves an unverified claim blocker during %s completion', async mode => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: 'claim-example', taskType: 'user', metadata: { claimFlow: true, claimTarget: '42' } };
    const taskOutcome = { status: 'blocked', reason: 'The issue may be parked; independent evidence is missing.' };
    persistedAgent.taskId = task.id;
    persistedAgent.metadata.taskOutcome = taskOutcome;
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    claimVerifier.verifyClaimDisposition.mockResolvedValue({ status: 'unverified', reason: 'block-authority-unverified' });
    try {
      if (mode === 'normal') await finalizeAgent({ agentId: persistedAgent.id, task, success: true, exitCode: 0,
        finalSummary: JSON.stringify({ summary: taskOutcome.reason, taskOutcome }) });
      else await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0, duration: 100 });
      expect(completeAgent).toHaveBeenLastCalledWith(persistedAgent.id, expect.objectContaining({ success: false, taskOutcome }));
      expect(persistedAgent.metadata.taskOutcomeSource).not.toBe('forge-verification');
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it('preserves a failed delivery gate during claim no-op recovery', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    const task = { id: 'claim-example', taskType: 'user', metadata: { claimFlow: true, claimTarget: '42' } };
    persistedAgent.taskId = task.id;
    persistedAgent.result = { validationPassed: false };
    persistedAgent.metadata.taskOutcome = { status: 'no-action-needed', reason: 'Issue was closed.' };
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    claimVerifier.verifyClaimDisposition.mockResolvedValue({ status: 'verified' });
    try {
      await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0, duration: 100 });
      expect(completeAgent).toHaveBeenLastCalledWith(persistedAgent.id, expect.objectContaining({ success: false,
        validationPassed: false, taskOutcome: { status: 'incomplete', reason: 'Delivery checks did not pass.' } }));
    } finally { isProgrammaticIoTaskType.mockReturnValue(true); }
  });

  it('accepts a coordinator no-op whose commit criterion was never declared', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    declaresNoCommitCriterion.mockReturnValue(true);
    const taskOutcome = { status: 'no-action-needed', reason: 'Inventory was already drained.' };
    const task = { id: 'reconcile-example', taskType: 'internal', metadata: { analysisType: 'branch-reconcile', app: 'app-example' } };
    try {
      await finalizeAgent({ agentId: 'agent-example', task, success: true, exitCode: 0, outputBuffer: '',
        finalSummary: JSON.stringify({ summary: 'Nothing left to reconcile.', taskOutcome }) });
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({
        success: true, executionSuccess: true, validationPassed: null, taskOutcome,
      }));
      expect(updateTask).toHaveBeenLastCalledWith(task.id, expect.objectContaining({
        status: 'completed', metadata: expect.objectContaining({ taskOutcome }),
      }), 'internal');
      expect(addTask).not.toHaveBeenCalled();
    } finally {
      isProgrammaticIoTaskType.mockReturnValue(true);
      declaresNoCommitCriterion.mockReturnValue(false);
    }
  });

  it('keeps a failed delivery gate ahead of a coordinator no-op', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    declaresNoCommitCriterion.mockReturnValue(true);
    const task = { id: 'reconcile-example', taskType: 'internal', metadata: { analysisType: 'branch-reconcile' } };
    persistedAgent.taskId = task.id;
    persistedAgent.result = { validationPassed: false };
    persistedAgent.metadata.taskOutcome = { status: 'no-action-needed', reason: 'Inventory was already drained.' };
    persistedAgent.metadata.taskOutcomeSource = 'terminal-result';
    try {
      await retireDeadAgent({ agent: persistedAgent, task, success: true, exitCode: 0, duration: 100 });
      expect(completeAgent).toHaveBeenLastCalledWith(persistedAgent.id, expect.objectContaining({
        success: false, validationPassed: false,
        taskOutcome: { status: 'incomplete', reason: 'Delivery checks did not pass.' },
      }));
    } finally {
      isProgrammaticIoTaskType.mockReturnValue(true);
      declaresNoCommitCriterion.mockReturnValue(false);
    }
  });

  it('holds an unverified no-op', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    try {
      const task = { id: 'user-example', taskType: 'user', metadata: {} };
      await finalizeAgent({ agentId: 'agent-example', task, success: true, exitCode: 0, outputBuffer: '',
        finalSummary: JSON.stringify({ summary: 'Invented no-op.', taskOutcome: { status: 'no-action-needed', reason: 'No changes made.' } }) });
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({ executionSuccess: true, success: false,
        taskOutcome: { status: 'incomplete', reason: 'The reported no-action-needed result was not verified.' } }));
    } finally {
      isProgrammaticIoTaskType.mockReturnValue(true);
    }
  });

  it('leaves legacy prose as unknown delivery when the agent has no saved outcome', async () => {
    isProgrammaticIoTaskType.mockReturnValue(false);
    try {
      const task = { id: 'user-example', taskType: 'user', metadata: {} };
      await finalizeAgent({ agentId: 'agent-example', task, success: true, exitCode: 0, outputBuffer: '',
        finalSummary: 'Status: BLOCKED - invented contradictory instructions' });
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({ executionSuccess: true, taskOutcome: null }));
    } finally {
      isProgrammaticIoTaskType.mockReturnValue(true);
    }
  });

  it('replays verified no-op recovery after terminal persistence fails without repeating its hook', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const workspacePath = await mkdtemp(join(tmpdir(), 'verified-noop-replay-'));
    const taskOutcome = { status: 'no-action-needed', reason: 'Invented verified no-op.' };
    persistedAgent.metadata.workspacePath = workspacePath;
    hook.mockResolvedValue({ accepted: true });
    completeAgent.mockRejectedValueOnce(new Error('invented persistence failure'));
    const finish = () => retireDeadAgent({ agent: persistedAgent, task: TASK, success: true, exitCode: 0, duration: 1000 });
    try {
      await writeFile(join(workspacePath, '.agent-done-agent-example'), JSON.stringify({ taskOutcome }));
      await expect(finish()).rejects.toThrow('invented persistence failure');
      await expect(finish()).resolves.toEqual({ success: true, taskOutcome, deliveryHeld: false });
      expect(hook).toHaveBeenCalledOnce();
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({ success: true, validationPassed: true, taskOutcome }));
    } finally { await rm(workspacePath, { recursive: true, force: true }); }
  });

  it.each([null, 'Invented terminal report.'])('retains an outcome-only sentinel on repeat finalization after cleanup with finalSummary=%s', async finalSummary => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const workspacePath = await mkdtemp(join(tmpdir(), 'outcome-replay-'));
    const sentinelPath = join(workspacePath, '.agent-done-agent-example');
    const taskOutcome = { status: 'blocked', reason: 'Invented prerequisite remains unmet.' };
    const finish = (finalSummary = null) => finalizeAgent({ agentId: 'agent-example', task: TASK, success: true,
      exitCode: 0, duration: 1000, workspacePath, finalSummary, outputBuffer: '' });
    try {
      await writeFile(sentinelPath, JSON.stringify({ taskOutcome }));
      await finish();
      await rm(sentinelPath);
      await finish(finalSummary);
      expect(completeAgent).toHaveBeenLastCalledWith('agent-example', expect.objectContaining({ success: false, executionSuccess: true, taskOutcome }));
      expect(updateTask).toHaveBeenLastCalledWith(TASK.id, expect.objectContaining({ status: 'in_progress', metadata: expect.objectContaining({ taskOutcome }) }), TASK.taskType);
      expect(persistedAgent.metadata.taskSummary).toBe(finalSummary);
    } finally { await rm(workspacePath, { recursive: true, force: true }); }
  });

  it.each(['sentinel', 'terminal-result', 'legacy'])('retains only authoritative %s summaries on repeat finalization after cleanup', async (source) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const workspacePath = await mkdtemp(join(tmpdir(), 'completion-replay-'));
    const sentinelPath = join(workspacePath, '.agent-done-summary-replay');
    persistedAgent.id = 'summary-replay';
    const task = { ...TASK, metadata: { ...TASK.metadata, auditDepth: 'deep' } };
    const finish = (finalSummary = null) => finalizeAgent({ agentId: 'summary-replay', task, success: true,
      exitCode: 0, duration: 1000, workspacePath, finalSummary, outputBuffer: 'exec: tool output' });
    try {
      if (source === 'legacy') {
        persistedAgent.metadata.taskSummary = 'Old heuristic tool transcript';
      } else {
        if (source === 'sentinel') await writeFile(sentinelPath, 'Saved partial completion.');
        await finish(source === 'terminal-result' ? 'Saved partial completion.' : null);
        expect(persistedAgent.metadata).toMatchObject({ taskSummary: 'Saved partial completion.', taskSummarySource: source });
        await rm(sentinelPath, { force: true });
      }
      await finish();
      expect(persistedAgent.metadata.taskSummary).toBe(source === 'legacy' ? null : 'Saved partial completion.');
      expect(persistedAgent.metadata.taskSummarySource).toBe(source === 'legacy' ? null : source);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });


it('finishes extended Deep with an honest partial summary through ordinary completion without ledger gates', async () => {
  const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security', auditDepth: 'deep', auditWorkflow: 'extended-v1', simplify: false } };
  recordAuditQuality.mockResolvedValue(true);
  await finalizeAgent({ agentId: 'extended-summary', task, success: true, exitCode: 0, duration: 1000,
    workspacePath: '/example/repo', finalSummary: 'Investigated high-risk paths and fixed two coherent defects. Coverage remains partial.', outputBuffer: 'tool transcript' });
  expect(deep.checkpointDeepAudit).not.toHaveBeenCalled();
  expect(deep.settleDeepAuditDelivery).not.toHaveBeenCalled();
  expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({ taskOutcome: null }) }), expect.anything());
  expect(persistedAgent.metadata.taskSummary).toContain('Coverage remains partial');
  expect(persistedAgent.metadata.taskSummarySource).toBe('terminal-result');
});

  it('parks a failed Deep attempt without the normal automatic retry path', async () => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security', auditDepth: 'deep' } };
    await finalizeAgent({ agentId: 'deep-failed', task, success: false, exitCode: 1, duration: 1000,
      workspacePath: '/example/repo', startedAt: Date.now() - 1000, outputBuffer: 'Context exhausted',
      errorAnalysis: { type: 'transient', retryable: true, error: 'context exhausted' } });
    expect(resolveFailedTaskUpdate).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'in_progress', metadata: expect.objectContaining({ retryPendingCleanup: expect.any(String) }) }), expect.anything());
    expect(deep.checkpointDeepAudit).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('distinguishes a clean execution with no usable assessment from a failed execution', async () => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'security' } };
    recordAuditQuality.mockResolvedValue(false);
    await expect(dispatchTaskOutputHookOnce({ agentId: 'audit-no-report', task, success: true, workspacePath: '/worktree' }))
      .resolves.toEqual({ ran: false, auditAssessment: { status: 'not-recorded' } });
    await expect(dispatchTaskOutputHookOnce({ agentId: 'audit-execution-failed', task, success: false, workspacePath: '/worktree' }))
      .resolves.toEqual({ ran: false, auditAssessment: { status: 'not-attempted' } });
    recordAuditQuality.mockResolvedValue(true);
  });

  it.each([
    ['orphan cleanup', false],
    ['post-restart completion', true],
  ])('runs a registered processTaskOutput hook for %s with no stale sentinel payload', async (_path, success) => {
    const result = await dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success,
    });

    expect(result).toEqual({ ran: true, outcome: { recorded: true } });
    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      agentId: persistedAgent.id,
      task: TASK,
      appId: 'app-example',
      success,
      payload: null,
      workspacePath: null,
    }));
    expect(updateAgent).toHaveBeenCalledWith(
      persistedAgent.id,
      { metadata: { outputHookDispatchedAt: expect.any(String), outputHookValidationPassed: expect.any(Boolean) } },
    );
  });

  it('deduplicates concurrent normal/recovery completion and persists the gate', async () => {
    let finishHook;
    hook.mockReturnValueOnce(new Promise(resolve => { finishHook = resolve; }));

    const normal = dispatchTaskOutputHookOnce({
      agentId: persistedAgent.id,
      task: TASK,
      success: true,
      workspacePath: '/example/worktree',
    });
    const recovery = dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    });

    expect(recovery).toBe(normal);
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
    finishHook({ recorded: true });
    await expect(normal).resolves.toEqual({ ran: true, outcome: { recorded: true } });

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toMatchObject({ ran: false, alreadyDispatched: true });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('keeps a timed-out hook recoverable until the original dispatch settles', async () => {
    vi.useFakeTimers();
    let finishHook;
    hook.mockReturnValueOnce(new Promise(resolve => { finishHook = resolve; }));

    const original = dispatchTaskOutputHookOnce({
      agentId: persistedAgent.id,
      task: TASK,
      success: true,
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(original).resolves.toEqual({ ran: false, timedOut: true });
    expect(updateAgent).not.toHaveBeenCalled();
    expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).toBe(original);

    finishHook({ recorded: true });
    await vi.waitFor(() => expect(updateAgent).toHaveBeenCalledWith(
      persistedAgent.id,
      { metadata: { outputHookDispatchedAt: expect.any(String), outputHookValidationPassed: expect.any(Boolean) } },
    ));
    vi.useRealTimers();

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toMatchObject({ ran: false, alreadyDispatched: true });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('does not dispatch after finalizeAgent persisted the explicit hook marker', async () => {
    persistedAgent.metadata.outputHookDispatchedAt = new Date().toISOString();

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toMatchObject({ ran: false, alreadyDispatched: true });
    expect(hook).not.toHaveBeenCalled();
  });

  it('still dispatches for an agent completed early by terminate/kill before finalizeAgent', async () => {
    persistedAgent.status = 'completed';

    await expect(dispatchTaskOutputHookOnce({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toEqual({ ran: true, outcome: { recorded: true } });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('does not persist a dispatch marker when recovery has no registered hook', async () => {
    getTaskOutputHook.mockResolvedValueOnce(null);

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toEqual({ ran: false });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('does not invoke a payload-dependent hook when recovery cannot read a sentinel', async () => {
    canRunTaskOutputHookWithoutPayload.mockReturnValueOnce(false);

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: true,
    })).resolves.toEqual({ ran: false, recoveryPayloadUnavailable: true });
    expect(hook).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('reads a live completion from task.metadata.repoPath but denies a recovery run that fallback', async () => {
    await dispatchTaskOutputHookOnce({ agentId: 'agent-live', task: TASK, success: true });
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/example/repo' }));

    persistedAgent.metadata = {};
    canRunTaskOutputHookWithoutPayload.mockReturnValueOnce(false);
    await expect(dispatchRecoveredTaskOutputHook({ agentId: 'agent-recovered', task: TASK, success: true }))
      .resolves.toEqual({ ran: false, recoveryPayloadUnavailable: true });
    expect(hook).toHaveBeenCalledOnce();
  });
});

describe('recovery path wiring (#3182, #8440)', () => {
  // Both recovery paths (the orphan sweep in agentManagement.js and post-restart
  // recovery in agentLifecycle.js) call the shared `retireDeadAgent` (#8440) for
  // this step list now, so the ordering guard moved to pin ITS body instead of
  // each caller's inlined copy.
  it('both recovery paths retire through the shared retireDeadAgent', () => {
    const sweepStart = MANAGEMENT_SOURCE.indexOf('async function runCleanupOrphanedAgents');
    const sweepBody = MANAGEMENT_SOURCE.slice(sweepStart, sweepStart + 12_000);
    expect(sweepBody).toMatch(/await retireDeadAgent\(/);

    const recoveryStart = LIFECYCLE_SOURCE.indexOf('Completing untracked agent');
    const recoveryBody = LIFECYCLE_SOURCE.slice(recoveryStart, recoveryStart + 2_000);
    expect(recoveryBody).toMatch(/await retireDeadAgent\(/);
  });
});

// #6124: the escalation the old `hookRejected && success` guard could not reach.
// The pr-reviewer stage that produced no output exited NON-zero with no captured
// error, so the run was already `success === false` and the permanent verdict
// never applied — the task consumed its retries and the pipeline re-spawned.
describe('permanent output-hook rejection (#6124)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgent.mockResolvedValue({ id: 'agent-rejected', metadata: {} });
    updateAgent.mockResolvedValue(null);
    getTaskOutputHook.mockResolvedValue(async () => ({
      accepted: false, permanent: true, reason: 'output-missing', message: 'No parseable output',
    }));
  });

  const finish = (errorAnalysis, metadata = {}) => finalizeAgent({
    agentId: 'agent-rejected',
    task: { ...TASK, metadata: { ...TASK.metadata, ...metadata } },
    runId: 'run-rejected', success: false, exitCode: 1, duration: 1000,
    outputBuffer: '', errorAnalysis,
  });

  it('blocks an already-failed unknown run and records failure for cleanup and run history', async () => {
    expect(await finish({ category: 'unknown' })).toMatchObject({ success: false });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({
      status: 'blocked', metadata: expect.objectContaining({ blockedCategory: 'output-missing' }),
    }), 'internal');
    expect(completeAgent).toHaveBeenCalledWith('agent-rejected', expect.objectContaining({
      success: false, completionReason: 'output-missing', error: 'No parseable output',
      errorAnalysis: expect.objectContaining({ permanent: true, origin: 'task-output-hook' }),
    }));
    expect(completeAgentRun).toHaveBeenCalledWith('run-rejected', '', 1, 1000,
      expect.objectContaining({ category: 'output-missing', permanent: true }), false, expect.objectContaining({ executionSuccess: false, taskOutcome: { status: 'incomplete', reason: 'Delivery checks did not pass.' } }));
    expect(addTask).not.toHaveBeenCalled();
    // The task's retry decision is resolved once, against the final verdict —
    // not once for the run's own failure and again for the escalation (#9645).
    expect(resolveFailedTaskUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves a named failure on its ordinary retry path', async () => {
    await finish({ category: 'rate-limit', message: 'Try later' });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({
      status: 'in_progress', metadata: expect.objectContaining({ lastErrorCategory: 'rate-limit' }),
    }), 'internal');
    expect(completeAgent).toHaveBeenCalledWith('agent-rejected', expect.objectContaining({
      error: 'Try later', completionReason: 'rate-limit',
      errorAnalysis: { category: 'rate-limit', message: 'Try later' },
    }));
    expect(resolveFailedTaskUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not re-resolve an already-blocked task or duplicate its investigation', async () => {
    await finish({ category: 'unknown' }, { failureCount: MAX_TASK_RETRIES - 1 });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({ status: 'blocked' }), 'internal');
    expect(resolveFailedTaskUpdate).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledTimes(1);
  });
});
