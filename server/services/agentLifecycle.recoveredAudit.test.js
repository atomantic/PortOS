import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ records: new Map(), tasks: [], trace: [], quality: [], serial: 0 }));
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), {
    dataRoot: () => lazyTempDataRoot('portos-recovered-audit-'),
    extraOverrides: root => ({ root: join(root, 'primary') }),
  });
});
vi.mock('../lib/maintenanceAdmission.js', () => ({ maintenance: {
  continueSettlement: fn => fn(), recoverOwned: vi.fn(), withResource: (_kind, _id, fn) => fn(), finishResource: vi.fn(), markResourceUnsettled: vi.fn(),
} }));
vi.mock('./cosRunnerClient.js', () => ({
  getActiveAgentsFromRunner: vi.fn(), connectTuiSessionViaRunner: vi.fn(),
  spawnAgentViaRunner: vi.fn(), getRunnerHealth: vi.fn(), classifyRunnerSpawnFailure: vi.fn(),
}));
vi.mock('./shell.js', () => ({ getSession: vi.fn(() => ({})) }));
vi.mock('./cosAgentLifecycle.js', async importOriginal => ({
  ...(await importOriginal()),
  readAgentRecordOrUnreadable: vi.fn(),
  getAgent: vi.fn(async id => fixture.records.get(id)),
  getAgentRecord: vi.fn(async id => fixture.records.get(id)),
  updateAgent: vi.fn(async (id, update) => {
    const record = fixture.records.get(id);
    Object.assign(record, { ...update, metadata: { ...record.metadata, ...update.metadata } });
    if (update.metadata?.auditFindings) fixture.trace.push('findings');
    return record;
  }),
  recordCompletionCleanup: async (id, startedAt, patch) => {
    const record = fixture.records.get(id);
    if (record?.status !== 'completed' || record.startedAt !== startedAt) return false;
    const prior = record.metadata.completionCleanup || {};
    record.metadata.completionCleanup = { ...prior, ...patch, stages: { ...prior.stages, ...patch.stages } };
    return true;
  },
  completeAgent: vi.fn(async (id, result) => {
    fixture.trace.push('complete');
    Object.assign(fixture.records.get(id), { status: 'completed', result });
  }),
}));
vi.mock('./cosTaskStore.js', () => ({
  getAllTasks: vi.fn(async () => ({ user: { grouped: {} }, cos: { grouped: { active: fixture.tasks } } })),
  getTaskById: vi.fn(async id => fixture.tasks.find(t => t.id === id)),
  updateTask: vi.fn(async (id, update) => Object.assign(fixture.tasks.find(t => t.id === id), update)),
  addTask: vi.fn(), reviveBlockedTask: vi.fn(),
}));
vi.mock('./cosTaskGenerator.js', () => ({ checkStagePrecondition: vi.fn() }));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(async id => {
    fixture.trace.push('cleanup');
    const record = fixture.records.get(id);
    // Model the destructive boundary only; real finalization must save both
    // receipts before the checkout disappears.
    expect(record.metadata.auditFindings.status).toBe('complete');
    expect(record.metadata.auditAssessment.status).toBe('recorded');
    await rm(record.metadata.workspacePath, { recursive: true, force: true });
    return [];
  }),
  releaseRetryHold: vi.fn(async () => ({})), spawnMergeRecoveryTask: vi.fn(),
}));
vi.mock('../lib/db.js', () => ({ ensureSchema: vi.fn(), query: vi.fn(async (_sql, values) => {
  fixture.trace.push('quality');
  fixture.quality.push({ category: values[1], agentId: values[2], report: JSON.parse(values[4]) });
  return { rows: [] };
}) }));
vi.mock('./appQualityFederation.js', () => ({
  collectAppQuality: vi.fn(), qualityRecord: vi.fn(), readQualityRecords: vi.fn(), readReleaseQuality: vi.fn(),
}));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(async () => null) }));
vi.mock('./codeReview.js', () => ({
  getGoalFidelityConfig: vi.fn(async () => null), runLocalGoalFidelityReview: vi.fn(),
  resolveReviewLoopOptions: vi.fn(async () => ({})),
}));
vi.mock('../lib/primaryCheckoutGuard.js', async importOriginal => ({
  ...(await importOriginal()), detectPrimaryCheckoutDrift: vi.fn(async () => ({})),
}));
vi.mock('../lib/gitCommitProbe.js', async importOriginal => ({
  ...(await importOriginal()), committedDuringRun: vi.fn(async () => false),
}));
vi.mock('./agentErrorAnalysis.js', async importOriginal => ({
  ...(await importOriginal()), resolveFailedTaskUpdate: vi.fn(async () => ({ status: 'blocked' })),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: vi.fn() }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn() }));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn() }));
vi.mock('./taskSchedule.js', () => ({ recordTaskTypeSuccess: vi.fn(async () => null), recordTaskTypeFailure: vi.fn(async () => null) }));
vi.mock('./agentSpawnPreparation.js', () => ({ createAgentSpawnContext: vi.fn(), prepareAgentSpawn: vi.fn() }));
vi.mock('./agentSpawnDispatch.js', () => ({ dispatchAgentRun: vi.fn() }));
vi.mock('./agentManagement.js', () => ({ handleOrphanedTask: vi.fn() }));
vi.mock('./agentCliSpawning.js', () => ({ isClaudeCliProvider: vi.fn(), getClaudeSettingsEnv: vi.fn() }));
vi.mock('./forgeAuth.js', () => ({ resolveForgeTokenEnv: vi.fn() }));
vi.mock('./agentApiAuth.js', () => ({ resolveAgentApiEnv: vi.fn() }));
vi.mock('./providers.js', () => ({ getActiveProvider: vi.fn() }));
vi.mock('./providerStatus.js', () => ({ markProviderUsageLimit: vi.fn(), markProviderUnavailable: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({ completeExecution: vi.fn(), errorExecution: vi.fn() }));
vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./updateChecker.js', () => ({ isUpdateInProgress: vi.fn(() => false) }));
vi.mock('./jira.js', () => ({}));
vi.mock('./git.js', () => ({}));
vi.mock('./brainTaskThreads.js', () => ({ ensureTaskThread: vi.fn() }));
vi.mock('./issueReconcile.js', () => ({ issueNumberFromRef: vi.fn() }));

import { PATHS } from '../lib/fileUtils.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { AGENT_RECORD_UNREADABLE, readAgentRecordOrUnreadable } from './cosAgentLifecycle.js';
import { getActiveAgentsFromRunner } from './cosRunnerClient.js';
import { cleanupAgentWorktree } from './agentWorktreeCleanup.js';
import { activeAgents, runnerAgents } from './agentState.js';
import { syncRunnerAgents } from './agentRunnerSync.js';
import { handleAgentCompletion } from './agentLifecycle.js';

const report = { version: 1, findings: [{ key: 'example-candidate', title: 'Reviewed example candidate',
  path: 'server/example.js', severity: 2, confidence: 'high', evidence: 'Synthetic caller already handles this case.',
  classification: 'dismissed', disposition: { kind: 'not-actionable', reason: 'Existing caller preserves the contract.' } }] };
const quality = score => ({ version: 1, category: 'observability', score, worstSeverity: 0,
  coverage: 'partial', confidence: 'high', summary: 'Synthetic category review.', scannedFiles: 1, totalFiles: 2 });
const sentinel = (findings = report, score = 82) => JSON.stringify({ summary:
  `Reviewed synthetic source.\nAUDIT_FINDINGS_JSON: ${JSON.stringify(findings)}\nQUALITY_AUDIT_JSON: ${JSON.stringify(quality(score))}` });

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.records.clear();
  fixture.tasks.length = 0;
  fixture.trace.length = 0;
  fixture.quality.length = 0;
  runnerAgents.clear();
  activeAgents.clear();
  await mkdir(PATHS.cosAgents, { recursive: true });
});
afterAll(cleanupTempDataRoots);

async function recoveredRun({ primary = false, missingPath = false, unreadable = false } = {}) {
  const agentId = `agent-example-${++fixture.serial}`;
  const primaryPath = join(PATHS.data, `primary-${fixture.serial}`);
  const workspacePath = primary ? primaryPath : join(PATHS.data, `worktree-${fixture.serial}`);
  await mkdir(primaryPath, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const task = { id: `app-improve-example-${fixture.serial}`, taskType: 'internal', status: 'in_progress',
    metadata: { analysisType: 'observability', auditDispositionVersion: '1', app: 'example-app', repoPath: primaryPath, openPR: false } };
  const record = { id: agentId, taskId: task.id, status: 'running', startedAt: '2026-10-01T12:00:00.000Z',
    metadata: { auditDispositionVersion: 1, runId: `run-example-${fixture.serial}`,
      ...(!missingPath && !unreadable ? { workspacePath } : {}) } };
  fixture.records.set(agentId, record);
  fixture.tasks.push(task);
  readAgentRecordOrUnreadable.mockResolvedValue(unreadable ? AGENT_RECORD_UNREADABLE : record);
  getActiveAgentsFromRunner.mockResolvedValue([{ id: agentId, taskId: task.id, kind: 'tui',
    processActive: true, liveness: 'pty', startedAt: Date.parse(record.startedAt),
    ...(!missingPath ? { workspacePath } : {}) }]);
  await writeFile(join(primaryPath, `.agent-done-${agentId}`), sentinel({ version: 1, findings: [] }, 12));
  await writeFile(join(workspacePath, `.agent-done-${agentId}`), sentinel());
  await writeFile(join(workspacePath, `.agent-audit-findings-${agentId}.json`), JSON.stringify(report));
  await syncRunnerAgents();
  return { agentId, task, record, primaryPath, workspacePath };
}

describe('recovered runner audit completion (#11526)', () => {
  // This drives the real recovery -> finalizer -> audit/quality -> cleanup
  // sequence. The primary checkout's valid but different report is a decoy.
  it.each(['rehydrated', 'old entry without cwd', 'stale primary cwd'])('records worktree evidence before cleanup for a %s entry', async mode => {
    const run = await recoveredRun();
    if (mode === 'old entry without cwd') delete runnerAgents.get(run.agentId).workspacePath;
    if (mode === 'stale primary cwd') runnerAgents.get(run.agentId).workspacePath = run.primaryPath;
    await handleAgentCompletion(run.agentId, 0, true, 1000);
    expect(run.record.metadata.auditFindings).toMatchObject({ status: 'complete', report });
    expect(run.record.result).toMatchObject({ success: true, executionSuccess: true, taskOutcome: null, auditAssessment: { status: 'recorded' } });
    expect(fixture.quality).toEqual([{ category: 'observability', agentId: run.agentId, report: quality(82) }]);
    expect(fixture.trace.indexOf('findings')).toBeLessThan(fixture.trace.indexOf('quality'));
    expect(fixture.trace.indexOf('quality')).toBeLessThan(fixture.trace.indexOf('complete'));
    expect(fixture.trace.indexOf('complete')).toBeLessThan(fixture.trace.indexOf('cleanup'));
    expect(runnerAgents.has(run.agentId)).toBe(false);
    await expect(readFile(join(run.workspacePath, `.agent-done-${run.agentId}`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(run.primaryPath, `.agent-done-${run.agentId}`), 'utf8')).toBe(sentinel({ version: 1, findings: [] }, 12));
  });

  it('also records an explicitly registered primary-checkout audit', async () => {
    const run = await recoveredRun({ primary: true });
    await handleAgentCompletion(run.agentId, 0, true, 1000);
    expect(run.record.metadata.auditFindings).toMatchObject({ status: 'complete', report });
    expect(fixture.quality[0].report.score).toBe(82);
  });

  it('retains the runner cwd when the registration read is temporarily unavailable', async () => {
    const run = await recoveredRun({ unreadable: true });
    expect(runnerAgents.get(run.agentId).workspacePath).toBe(run.workspacePath);
    // The durable registration becomes readable again before completion.
    run.record.metadata.workspacePath = run.workspacePath;
    await handleAgentCompletion(run.agentId, 0, true, 1000);
    expect(run.record.metadata.auditFindings).toMatchObject({ status: 'complete', report });
  });

  it('does not borrow primary artifacts when neither registration nor runner knows the workspace', async () => {
    const run = await recoveredRun({ missingPath: true });
    await handleAgentCompletion(run.agentId, 0, true, 1000);
    expect(run.record.result).toMatchObject({ success: false, completionReason: 'audit-disposition-incomplete' });
    expect(run.record.metadata.auditFindings).toMatchObject({ status: 'incomplete', finalReportReceived: false, report: { version: 1, findings: [] } });
    expect(fixture.quality).toEqual([]);
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect(await readFile(join(run.workspacePath, `.agent-done-${run.agentId}`), 'utf8')).toBe(sentinel());
    expect(await readFile(join(run.primaryPath, `.agent-done-${run.agentId}`), 'utf8')).toBe(sentinel({ version: 1, findings: [] }, 12));
  });

  it.each(['malformed', 'missing'])('keeps the checkout and checkpoint after a %s final report', async kind => {
    const run = await recoveredRun();
    const donePath = join(run.workspacePath, `.agent-done-${run.agentId}`);
    if (kind === 'missing') await rm(donePath);
    else await writeFile(donePath, sentinel({ version: 1, findings: [{ invalid: true }] }));
    await handleAgentCompletion(run.agentId, 0, true, 1000);
    expect(run.record.result).toMatchObject({ success: false, completionReason: 'audit-disposition-incomplete' });
    expect(run.record.metadata.auditFindings).toMatchObject({ status: 'incomplete', finalReportReceived: false, report });
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect(await readFile(join(run.workspacePath, `.agent-audit-findings-${run.agentId}.json`), 'utf8')).toBe(JSON.stringify(report));
    if (kind === 'malformed') expect(await readFile(donePath, 'utf8')).toBe(sentinel({ version: 1, findings: [{ invalid: true }] }));
  });
});
