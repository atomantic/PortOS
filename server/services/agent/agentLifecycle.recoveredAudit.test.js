import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ trace: [], quality: [], serial: 0, completions: 0, retirements: [] }));
vi.mock('../../lib/paths.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), {
    dataRoot: () => lazyTempDataRoot('portos-recovered-audit-'),
    extraOverrides: root => ({ root: join(root, 'primary') }),
  });
});
vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: {
  continueSettlement: fn => fn(), recoverOwned: vi.fn(), withResource: (_kind, _id, fn) => fn(), finishResource: vi.fn(), markResourceUnsettled: vi.fn(),
  operations: () => [],
} }));
vi.mock('../cos/cosTaskGenerator.js', () => ({ evaluateTasks: vi.fn(async () => {}) }));
vi.mock('../cos/cosRunnerClient.js', () => ({
  getActiveAgentsFromRunner: vi.fn(), connectTuiSessionViaRunner: vi.fn(),
  spawnAgentViaRunner: vi.fn(), getRunnerHealth: vi.fn(), classifyRunnerSpawnFailure: vi.fn(),
}));
vi.mock('../shell.js', () => ({ getSession: vi.fn(() => ({})) }));
vi.mock('../cos/cosAgentLifecycle.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    readAgentRecordOrUnreadable: vi.fn(actual.readAgentRecordOrUnreadable),
    updateAgent: async (id, update) => {
      const record = await actual.updateAgent(id, update);
      if (update.metadata?.auditFindings) fixture.trace.push('findings');
      return record;
    },
    completeAgent: async (...args) => {
      const record = await actual.completeAgent(...args);
      fixture.trace.push('complete');
      return record;
    },
  };
});
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(async id => {
    fixture.trace.push('cleanup');
    const record = await getAgentRecord(id);
    // Model the destructive boundary only; real finalization must save both
    // receipts before the checkout disappears.
    expect(record.metadata.auditFindings.status).toBe('complete');
    expect(record.metadata.auditAssessment.status).toBe('recorded');
    await rm(record.metadata.workspacePath, { recursive: true, force: true });
    return [];
  }),
  resolveTaskResumePatch: vi.fn(async () => ({})),
  releaseRetryHold: vi.fn(async () => ({})), spawnMergeRecoveryTask: vi.fn(),
}));
vi.mock('../../lib/db.js', () => ({ ensureSchema: vi.fn(), query: vi.fn(async (_sql, values) => {
  fixture.trace.push('quality');
  fixture.quality.push({ category: values[1], agentId: values[2], report: JSON.parse(values[4]) });
  return { rows: [] };
}) }));
vi.mock('../apps.js', () => ({ getAppById: vi.fn(async () => null) }));
vi.mock('../codeReview.js', () => ({
  getGoalFidelityConfig: vi.fn(async () => null), runLocalGoalFidelityReview: vi.fn(),
  resolveReviewLoopOptions: vi.fn(async () => ({})),
}));
vi.mock('../../lib/primaryCheckoutGuard.js', async importOriginal => ({
  ...(await importOriginal()), detectPrimaryCheckoutDrift: vi.fn(async () => ({})),
}));
vi.mock('../../lib/gitCommitProbe.js', async importOriginal => ({
  ...(await importOriginal()), committedDuringRun: vi.fn(async () => false),
}));
vi.mock('./agentErrorAnalysis.js', async importOriginal => ({
  ...(await importOriginal()), resolveFailedTaskUpdate: vi.fn(async () => ({ status: 'blocked' })),
}));
vi.mock('../cos/cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn() }));
vi.mock('./agentProcessProbe.js', async importOriginal => ({
  ...(await importOriginal()),
  isPidAlive: vi.fn(async () => false),
}));
vi.mock('./agentManagement.js', () => ({ handleOrphanedTask: vi.fn() }));
// handleAgentCompletion launches retirement from its finally block without
// returning it; keep the real work but own the promise so teardown can drain it.
vi.mock('./agentRepoStateVerification.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, resumeAgentCompletionRetirement: vi.fn(agentId => {
    const run = actual.resumeAgentCompletionRetirement(agentId);
    fixture.retirements.push(run);
    return run;
  }) };
});

import { PATHS } from '../../lib/fileUtils.js';
import { cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
import { storedForm } from '../../lib/cos/cosTaskRows.js';
import { __resetCosTaskRepository, applyTaskListSave, readTaskListVersion } from '../cos/cosTaskRepository.js';
import { __resetTaskCache, getTaskById } from '../cos/cosTaskStore.js';
import { loadState, saveState } from '../cos/cosState.js';
import { AGENT_RECORD_UNREADABLE, getAgentRecord, readAgentRecordOrUnreadable, updateAgent } from '../cos/cosAgentLifecycle.js';
import { getActiveAgentsFromRunner } from '../cos/cosRunnerClient.js';
import { cleanupAgentWorktree } from './agentWorktreeCleanup.js';
import { bindCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';
import { cleanupOrphanedAgents } from './agentOrphanRecovery.js';
import { completeAgentRun } from './agentRunTracking.js';
import { activeAgents, runnerAgents } from './agentState.js';
import { syncRunnerAgents } from './agentRunnerSync.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
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
  __resetTaskCache();
  __resetCosTaskRepository();
  const state = await loadState();
  state.agents = {};
  await saveState(state);
  fixture.trace.length = 0;
  fixture.quality.length = 0;
  runnerAgents.clear();
  activeAgents.clear();
  await mkdir(PATHS.cosAgents, { recursive: true });
});
afterEach(async () => {
  // The deferred retirement is scheduled through a dynamic import, so wait for
  // each completion's launch before awaiting the launched work: resetting the
  // shared records or removing the temp root underneath it is what made a
  // published completion payload vanish mid-read (#13461).
  await vi.waitFor(() => expect(fixture.retirements).toHaveLength(fixture.completions));
  await Promise.allSettled(fixture.retirements);
  fixture.completions = 0;
  fixture.retirements.length = 0;
});
afterAll(cleanupTempDataRoots);

async function seedRun(task, record) {
  await applyTaskListSave('internal', {
    upserts: [{ task: storedForm(task, 'internal'), position: 0 }],
    deletes: [],
    expectedVersions: { internal: await readTaskListVersion('internal') },
  });
  const state = await loadState();
  state.agents[record.id] = record;
  await saveState(state);
}

const complete = agentId => {
  fixture.completions++;
  return handleAgentCompletion(agentId, 0, true, 1000);
};

describe('dead agent recovery (#3182, #8440)', () => {
  it.each([
    { mode: 'orphan sweep', exitCode: 1, success: false, taskStatus: 'pending' },
    { mode: 'untracked completion', exitCode: 0, success: true, taskStatus: 'completed' },
  ])('settles the saved output and task through $mode', async ({ mode, exitCode, success, taskStatus }) => {
    const startedAt = '2026-10-01T12:00:00.000Z';
    const task = { id: 'sys-example-recovery', taskType: 'internal', status: 'in_progress', priority: 'MEDIUM', description: 'Synthetic recovery task',
      metadata: { claimedBy: 'example-install', lastSpawnedAt: startedAt, totalSpawnCount: 1 } };
    const record = { id: 'agent-example-recovery', taskId: task.id, status: 'running', pid: 12345, startedAt,
      metadata: { runId: 'run-example-recovery' }, output: ['Synthetic output', { line: 'Saved before restart' }] };
    await seedRun(task, record);
    expect(await bindCompletionTaskDispatch(record.id, task)).toBe(true);

    if (mode === 'orphan sweep') {
      getActiveAgentsFromRunner.mockResolvedValueOnce([]);
      cleanupAgentWorktree.mockResolvedValueOnce([]);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        await expect(cleanupOrphanedAgents()).resolves.toBe(1);
      } finally {
        vi.useRealTimers();
      }
    } else {
      await complete(record.id);
    }

    expect(completeAgentRun).toHaveBeenCalledExactlyOnceWith(record.metadata.runId,
      'Synthetic output\nSaved before restart', exitCode, expect.any(Number),
      expect.objectContaining({ category: success ? undefined : 'orphaned' }),
      success ? null : false, expect.objectContaining({ executionSuccess: success }));
    expect(await getAgentRecord(record.id)).toMatchObject({ status: 'completed', result: { orphaned: true, exitCode, success } });
    expect((await getTaskById(task.id)).status).toBe(taskStatus);
  });
});

async function recoveredRun({ primary = false, missingPath = false, unreadable = false } = {}) {
  const agentId = `agent-example-${++fixture.serial}`;
  const primaryPath = join(PATHS.data, `primary-${fixture.serial}`);
  const workspacePath = primary ? primaryPath : join(PATHS.data, `worktree-${fixture.serial}`);
  await mkdir(primaryPath, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const task = { id: `app-improve-example-${fixture.serial}`, taskType: 'internal', status: 'in_progress', priority: 'MEDIUM', description: 'Synthetic recovery task',
    metadata: { analysisType: 'observability', auditDispositionVersion: '1', app: 'example-app', repoPath: primaryPath, openPR: false } };
  const record = { id: agentId, taskId: task.id, status: 'running', startedAt: '2026-10-01T12:00:00.000Z',
    metadata: { auditDispositionVersion: 1, runId: `run-example-${fixture.serial}`,
      ...(!missingPath && !unreadable ? { workspacePath } : {}) } };
  await seedRun(task, record);
  if (unreadable) readAgentRecordOrUnreadable.mockResolvedValueOnce(AGENT_RECORD_UNREADABLE);
  getActiveAgentsFromRunner.mockResolvedValue([{ id: agentId, taskId: task.id, kind: 'tui',
    processActive: true, liveness: 'pty', startedAt: Date.parse(record.startedAt),
    ...(!missingPath ? { workspacePath } : {}) }]);
  await writeFile(join(primaryPath, `.agent-done-${agentId}`), sentinel({ version: 1, findings: [] }, 12));
  await writeFile(join(workspacePath, `.agent-done-${agentId}`), sentinel());
  await writeFile(join(workspacePath, `.agent-audit-findings-${agentId}.json`), JSON.stringify(report));
  await syncRunnerAgents();
  return { agentId, primaryPath, workspacePath };
}

describe('recovered runner audit completion (#11526)', () => {
  // This drives the real recovery -> finalizer -> audit/quality -> cleanup
  // sequence. The primary checkout's valid but different report is a decoy.
  it.each(['rehydrated', 'old entry without cwd', 'stale primary cwd'])('records worktree evidence before cleanup for a %s entry', async mode => {
    const run = await recoveredRun();
    if (mode === 'old entry without cwd') delete runnerAgents.get(run.agentId).workspacePath;
    if (mode === 'stale primary cwd') runnerAgents.get(run.agentId).workspacePath = run.primaryPath;
    await complete(run.agentId);
    expect((await getAgentRecord(run.agentId)).metadata.auditFindings).toMatchObject({ status: 'complete', report });
    expect((await getAgentRecord(run.agentId)).result).toMatchObject({ success: true, executionSuccess: true, taskOutcome: null, auditAssessment: { status: 'recorded' } });
    expect(fixture.quality).toEqual([{ category: 'observability', agentId: run.agentId, report: quality(82) }]);
    expect(fixture.trace.indexOf('findings')).toBeLessThan(fixture.trace.indexOf('quality'));
    expect(fixture.trace.indexOf('quality')).toBeLessThan(fixture.trace.indexOf('complete'));
    expect(fixture.trace.indexOf('complete')).toBeLessThan(fixture.trace.indexOf('cleanup'));
    expect(runnerAgents.has(run.agentId)).toBe(false);
    expect(maintenance.finishResource).toHaveBeenCalledExactlyOnceWith('agent', run.agentId);
    await expect(readFile(join(run.workspacePath, `.agent-done-${run.agentId}`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(run.primaryPath, `.agent-done-${run.agentId}`), 'utf8')).toBe(sentinel({ version: 1, findings: [] }, 12));
  });

  it('also records an explicitly registered primary-checkout audit', async () => {
    const run = await recoveredRun({ primary: true });
    await complete(run.agentId);
    expect((await getAgentRecord(run.agentId)).metadata.auditFindings).toMatchObject({ status: 'complete', report });
    expect(fixture.quality[0].report.score).toBe(82);
  });

  it('retains the runner cwd when the registration read is temporarily unavailable', async () => {
    const run = await recoveredRun({ unreadable: true });
    expect(runnerAgents.get(run.agentId).workspacePath).toBe(run.workspacePath);
    // The durable registration becomes readable again before completion.
    await updateAgent(run.agentId, { metadata: { workspacePath: run.workspacePath } });
    await complete(run.agentId);
    expect((await getAgentRecord(run.agentId)).metadata.auditFindings).toMatchObject({ status: 'complete', report });
  });

  it('does not borrow primary artifacts when neither registration nor runner knows the workspace', async () => {
    const run = await recoveredRun({ missingPath: true });
    await complete(run.agentId);
    expect((await getAgentRecord(run.agentId)).result).toMatchObject({ success: false, completionReason: 'audit-disposition-incomplete' });
    expect((await getAgentRecord(run.agentId)).metadata.auditFindings).toMatchObject({ status: 'incomplete', finalReportReceived: false, report: { version: 1, findings: [] } });
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
    await complete(run.agentId);
    expect((await getAgentRecord(run.agentId)).result).toMatchObject({ success: false, completionReason: 'audit-disposition-incomplete' });
    expect((await getAgentRecord(run.agentId)).metadata.auditFindings).toMatchObject({ status: 'incomplete', finalReportReceived: false, report });
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect(await readFile(join(run.workspacePath, `.agent-audit-findings-${run.agentId}.json`), 'utf8')).toBe(JSON.stringify(report));
    if (kind === 'malformed') expect(await readFile(donePath, 'utf8')).toBe(sentinel({ version: 1, findings: [{ invalid: true }] }));
  });
});
