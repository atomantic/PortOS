import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const fixture = vi.hoisted(() => ({ recordPath: null, runRoot: null, failWrite: false, indexReady: true }));
vi.mock('./cosAgentIndex.js', () => ({
  loadAgentIndex: async () => { fixture.indexReady = true; return new Map(); },
  getAgentDir: id => join(fixture.runRoot, ...(fixture.indexReady ? [] : ['unindexed']), id),
}));
vi.mock('./cos.js', () => ({}));
vi.mock('./cosEvents.js', async original => ({ ...await original(), emitLog: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({ updateTask: vi.fn(async () => ({})), addTask: vi.fn(), reviveBlockedTask: vi.fn(), getTaskById: vi.fn(async () => null) }));
vi.mock('./cosTaskGenerator.js', () => ({ checkStagePrecondition: () => ({ passed: true }) }));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: async () => JSON.parse(await readFile(fixture.recordPath, 'utf8')),
  getAgentRecord: async () => JSON.parse(await readFile(fixture.recordPath, 'utf8')),
  updateAgent: vi.fn(),
  recordCompletionCleanup: async (_id, startedAt, patch) => {
    if (fixture.failWrite) throw new Error('synthetic durable write failure');
    const agent = JSON.parse(await readFile(fixture.recordPath, 'utf8'));
    if (agent.status !== 'completed' || agent.startedAt !== startedAt) return false;
    const prior = agent.metadata.completionCleanup || {};
    agent.metadata.completionCleanup = { ...prior, ...patch, stages: { ...prior.stages, ...patch.stages } };
    if (['completed', 'failed', 'abandoned'].includes(agent.metadata.completionCleanup.status)) {
      delete agent.metadata.completionCleanup.context; delete agent.metadata.completionCleanup.replay;
    }
    await writeFile(fixture.recordPath, JSON.stringify(agent));
    return true;
  },
}));
vi.mock('./jira.js', () => ({}));
vi.mock('./git.js', () => ({}));
vi.mock('./codeReview.js', () => ({ resolveReviewLoopOptions: async () => ({}) }));
vi.mock('./agentWorktreeCleanup.js', () => ({ cleanupAgentWorktree: vi.fn(async () => []), releaseRetryHold: vi.fn(async () => ({})), spawnMergeRecoveryTask: vi.fn(async () => ({ id: 'existing-recovery' })) }));
vi.mock('./creativeDirector/completionHook.js', () => ({ handleCreativeDirectorCompletion: vi.fn() }));
vi.mock('./brainTaskThreads.js', () => ({ ensureTaskThread: vi.fn() }));
vi.mock('./auditFindings.js', () => ({ settleAuditFindings: vi.fn() }));

import { runAgentCompletionCleanup, replayAgentCompletionCleanup } from './agentCompletionCleanup.js';
import { storeCompletionData, readCompletionData } from './agentCompletionData.js';
import { readCompletionSentinel } from './agentCompletionSentinel.js';
import { cleanupAgentWorktree } from './agentWorktreeCleanup.js';
import { handleCreativeDirectorCompletion } from './creativeDirector/completionHook.js';
import { updateTask, addTask, getTaskById } from './cosTaskStore.js';
import { settleAuditFindings } from './auditFindings.js';

describe('durable post-ingestion cleanup replay', () => {
  let root;
  let workspace;
  let marker;
  const task = { id: 'task-one', taskType: 'user', metadata: {} };
  const saved = async () => JSON.parse(await readFile(fixture.recordPath, 'utf8'));
  const finish = (ownedTask = task) => runAgentCompletionCleanup({ agentId: 'agent-one', task: ownedTask,
    agent: {}, effectiveSuccess: true, outputBuffer: 'Delivered summary' });

  beforeEach(async () => {
    vi.clearAllMocks();
    fixture.failWrite = false;
    root = await mkdtemp(join(tmpdir(), 'portos-completion-replay-'));
    fixture.runRoot = join(root, 'runs');
    workspace = join(root, 'repo');
    await materializeGitRepo(workspace);
    marker = join(workspace, '.agent-done-agent-one');
    const contents = JSON.stringify({ summary: 'Delivered summary', payload: { result: 'original payload' } });
    await writeFile(marker, contents);
    fixture.recordPath = join(root, 'agent.json');
    const evidence = await readCompletionSentinel('agent-one', workspace);
    await writeFile(fixture.recordPath, JSON.stringify({ id: 'agent-one', taskId: task.id, status: 'completed',
      startedAt: '2026-01-01T00:00:00Z', result: { success: true }, metadata: { workspacePath: workspace,
        completionSentinel: evidence.receipt, completionSentinelContents: contents,
        completionCleanup: { version: 1, status: 'pending', stages: {} } } }));
    cleanupAgentWorktree.mockReset().mockResolvedValue([]);
    updateTask.mockReset().mockResolvedValue({});
    handleCreativeDirectorCompletion.mockReset().mockResolvedValue({});
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

  it('acknowledges durable ingestion and runs eligible Git cleanup despite pipeline failure, preserving its failed stage', async () => {
    const head = (await execGit(['rev-parse', 'HEAD'], workspace)).stdout;
    updateTask.mockResolvedValueOnce({ error: 'pipeline unavailable' });
    cleanupAgentWorktree.mockImplementationOnce(async () => {
      expect((await execGit(['status', '--porcelain'], workspace)).stdout).toBe('');
      expect((await saved()).metadata.completionSentinelContents).toContain('original payload');
      return [];
    });
    const pipelineTask = { ...task, metadata: { pipeline: { id: 'pipeline-one', status: 'running', currentStage: 0,
      stageResults: [], stages: [{ name: 'Only stage' }] } } };
    await expect(finish(pipelineTask)).rejects.toThrow('pipeline unavailable');
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(1);
    const record = await saved();
    expect(record.metadata.completionCleanup).toMatchObject({ status: 'failed', stages: {
      sentinel: { status: 'done' }, pipeline: { status: 'failed', retryable: false }, worktree: { status: 'done' },
    } });
    expect(record.result.success).toBe(true);
    expect(record.metadata.completionCleanup).not.toHaveProperty('context');
    expect(record.metadata.completionCleanup).not.toHaveProperty('replay');
    await replayAgentCompletionCleanup(record);
    expect(updateTask).toHaveBeenCalledTimes(1); // Unknown external hand-off is not republished.
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(1);
    expect((await execGit(['rev-parse', 'HEAD'], workspace)).stdout).toBe(head);
  });

  it.each(['repository-preservation-receipt', 'repository-state-verification'])('holds pending repository delivery and advances configured chains once after %s', async verifiedBy => {
    const record = await saved();
    record.result = { success: false, cleanupPending: true, executionSuccess: true };
    record.metadata.repoStateVerification = { status: 'pending' };
    await writeFile(fixture.recordPath, JSON.stringify(record));
    const pipelineTask = { ...task, metadata: { creativeDirector: { projectId: 'synthetic-project' },
      pipeline: { id: 'pipeline-one', status: 'running', currentStage: 0, stageResults: [], stages: [{ name: 'Only stage' }] } } };
    await finish(pipelineTask); // A designed hold must not create an unsettled maintenance failure.
    expect(updateTask).not.toHaveBeenCalled();
    expect(handleCreativeDirectorCompletion).not.toHaveBeenCalled();
    expect((await saved()).metadata.completionCleanup.stages).toMatchObject({
      pipeline: { status: 'held', retryable: true, reason: 'checkout-retirement-pending' },
      creative: { status: 'held', retryable: true, reason: 'checkout-retirement-pending' } });
    const transferred = await saved();
    transferred.metadata.repoStateVerification = { status: 'completed', reasons: ['cleanup-transferred-to-recovery'] };
    await writeFile(fixture.recordPath, JSON.stringify(transferred));
    await replayAgentCompletionCleanup(await saved());
    expect(updateTask).not.toHaveBeenCalled();
    expect(handleCreativeDirectorCompletion).not.toHaveBeenCalled();
    const verified = await saved();
    verified.metadata.repoStateVerification = { status: 'completed' };
    verified.metadata.completionCleanup.stages.worktree.verifiedBy = verifiedBy;
    await writeFile(fixture.recordPath, JSON.stringify(verified));
    await Promise.all([replayAgentCompletionCleanup(await saved()), replayAgentCompletionCleanup(await saved())]);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(handleCreativeDirectorCompletion).toHaveBeenCalledTimes(1);
    expect(handleCreativeDirectorCompletion).toHaveBeenCalledWith(pipelineTask, 'agent-one', true);
    expect((await saved()).metadata.completionCleanup.status).toBe('completed');
  });

  it('advances held chains once from a cleanup recheck receipt that defers task settlement', async () => {
    const record = await saved();
    record.result = { success: false, cleanupPending: true, executionSuccess: true };
    record.metadata.repoStateVerification = { status: 'pending' };
    await writeFile(fixture.recordPath, JSON.stringify(record));
    const pipelineTask = { ...task, metadata: { creativeDirector: { projectId: 'synthetic-project' },
      pipeline: { id: 'pipeline-one', status: 'running', currentStage: 0, stageResults: [], stages: [{ name: 'Only stage' }] } } };
    await finish(pipelineTask);
    // A worktree receipt alone, without the deferred settlement, is not the recheck's receipt.
    const receipt = await saved();
    receipt.metadata.completionCleanup.stages.worktree.verifiedBy = 'repository-state-verification';
    await writeFile(fixture.recordPath, JSON.stringify(receipt));
    await replayAgentCompletionCleanup(await saved());
    expect(updateTask).not.toHaveBeenCalled();
    expect(handleCreativeDirectorCompletion).not.toHaveBeenCalled();
    const deferred = await saved();
    deferred.metadata.completionCleanup.stages.worktree.taskSettlement = 'after-completion-stages';
    await writeFile(fixture.recordPath, JSON.stringify(deferred));
    await Promise.all([replayAgentCompletionCleanup(await saved()), replayAgentCompletionCleanup(await saved())]);
    await replayAgentCompletionCleanup(await saved());
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(handleCreativeDirectorCompletion).toHaveBeenCalledTimes(1);
    const settled = await saved();
    expect(settled.metadata.completionCleanup.status).toBe('completed');
    expect(settled.metadata.repoStateVerification).toEqual({ status: 'pending' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('re-verifies a received audit register on replay and releases preserved evidence only once it is complete', async () => {
    const auditTask = { ...task, metadata: { auditDispositionVersion: '1' } };
    const record = await saved();
    record.metadata.auditFindings = { version: 1, status: 'incomplete', finalReportReceived: true };
    await writeFile(fixture.recordPath, JSON.stringify(record));
    settleAuditFindings.mockResolvedValue({ status: 'incomplete' });
    await finish(auditTask);
    expect(settleAuditFindings).not.toHaveBeenCalled(); // The output hook already settled this pass.
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    await replayAgentCompletionCleanup(await saved());
    expect(settleAuditFindings).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-one', workspacePath: workspace }));
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect((await saved()).metadata.completionCleanup.status).toBe('pending');
    settleAuditFindings.mockResolvedValue({ status: 'complete' });
    await replayAgentCompletionCleanup(await saved());
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(1);
    expect((await saved()).metadata.completionCleanup.status).toBe('completed');
  });

  it.each([
    ['settles the blocked audit task its run still owns', {}, true],
    ['leaves a task re-dispatched since finalization alone', { lastSpawnedAt: '2026-01-02T00:00:00Z' }, false],
    ['leaves a task blocked for another reason alone', { blockedCategory: 'user-terminated' }, false],
  ])('once a replay verifies the register, %s', async (_label, drift, settles) => {
    const auditTask = { ...task, metadata: { auditDispositionVersion: '1' } };
    const record = await saved();
    record.metadata.auditFindings = { version: 1, status: 'incomplete', finalReportReceived: true };
    record.metadata.completionTaskDispatch = { taskId: task.id, taskType: 'user', expected: [['claimedBy', 'me'],
      ['claimedAt', '2026-01-01T00:00:00Z'], ['lastSpawnedAt', '2026-01-01T00:00:00Z'], ['totalSpawnCount', 1]] };
    await writeFile(fixture.recordPath, JSON.stringify(record));
    settleAuditFindings.mockResolvedValue({ status: 'incomplete' });
    await finish(auditTask);
    const blocked = { ...task, status: 'blocked', metadata: { blockedCategory: 'audit-disposition-incomplete',
      lastSpawnedAt: '2026-01-01T00:00:00Z', totalSpawnCount: '1', updatedAt: '2026-01-01T01:00:00Z', ...drift } };
    getTaskById.mockResolvedValue(blocked);
    settleAuditFindings.mockResolvedValue({ status: 'complete' });
    const resultBefore = (await saved()).result;
    await replayAgentCompletionCleanup(await saved());
    const completions = updateTask.mock.calls.filter(([, updates]) => updates?.status === 'completed');
    if (settles) {
      expect(completions).toEqual([[task.id, expect.objectContaining({ status: 'completed' }), 'user',
        { expectedStatus: 'blocked', expectedMetadata: { blockedCategory: 'audit-disposition-incomplete',
          updatedAt: '2026-01-01T01:00:00Z', lastSpawnedAt: '2026-01-01T00:00:00Z', totalSpawnCount: '1' } }]]);
    } else expect(completions).toEqual([]);
    expect((await saved()).result).toEqual(resultBefore);
  });

  it('persists an asynchronous chain failure without suppressing acknowledged cleanup or blindly publishing again', async () => {
    handleCreativeDirectorCompletion.mockRejectedValueOnce(new Error('chain write unavailable'));
    await expect(finish({ ...task, metadata: { creativeDirector: { projectId: 'synthetic-project' } } })).rejects.toThrow('chain write unavailable');
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(1);
    expect((await saved()).metadata.completionCleanup.stages.creative).toMatchObject({ status: 'failed', retryable: false });
    await replayAgentCompletionCleanup(await saved());
    expect(handleCreativeDirectorCompletion).toHaveBeenCalledTimes(1);
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(1);
  });

  it('finishes an acknowledgement interrupted after quarantine without deleting a newer canonical marker', async () => {
    const record = await saved();
    const held = `${marker}.ack-${record.metadata.completionSentinel.sha256}`;
    record.metadata.completionCleanup = { version: 1, status: 'pending', startedAt: record.startedAt,
      context: { task, effectiveSuccess: true, prOwnership: { taskOpenPR: false, agentOpensOwnPr: false } },
      stages: { sentinel: { status: 'running', retryable: true } } };
    await writeFile(fixture.recordPath, JSON.stringify(record));
    await rename(marker, held); // Crash boundary: durable ingestion exists; ACK has not committed.
    await writeFile(marker, 'a newer completion generation');
    await replayAgentCompletionCleanup(await saved());
    expect(await readFile(marker, 'utf8')).toBe('a newer completion generation');
    await expect(readFile(held)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await saved()).metadata.completionCleanup).toMatchObject({ status: 'pending', stages: { sentinel: { status: 'done' },
      worktree: { status: 'held', reason: 'completion-sentinel-generation-pending' } } });
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
  });

  it('replays only the failed worktree stage after restart and preserves a newer marker across duplicate callbacks', async () => {
    cleanupAgentWorktree.mockRejectedValueOnce(new Error('transient Git read'));
    await expect(finish()).rejects.toThrow('transient Git read');
    expect((await saved()).metadata.completionCleanup.stages.worktree).toMatchObject({ status: 'failed', retryable: true });
    // Reloading the JSON record models the completed-record callback after restart.
    await Promise.all([replayAgentCompletionCleanup(await saved()), replayAgentCompletionCleanup(await saved())]);
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(2);
    expect((await saved()).metadata.completionCleanup.status).toBe('completed');
    await writeFile(marker, 'new generation must survive');
    await Promise.all([replayAgentCompletionCleanup(await saved()), replayAgentCompletionCleanup(await saved())]);
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(2);
    expect(await readFile(marker, 'utf8')).toBe('new generation must survive');
    await replayAgentCompletionCleanup(await saved());
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(2);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('refuses acknowledgement when its run-bound ingestion artifact is corrupt, retaining the original marker and checkout', async () => {
    const record = await saved();
    record.metadata.completionSentinelData = await storeCompletionData(record, 'sentinel', record.metadata.completionSentinelContents);
    delete record.metadata.completionSentinelContents;
    await writeFile(fixture.recordPath, JSON.stringify(record));
    const reference = record.metadata.completionSentinelData;
    await writeFile(join(fixture.runRoot, record.id, 'completion', `sentinel-${reference.sha256}.json`), 'corrupt');
    await expect(finish()).rejects.toThrow('completion-data-size-changed');
    expect(await readFile(marker, 'utf8')).toContain('original payload');
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect((await saved()).metadata.completionCleanup).toMatchObject({ status: 'pending', stages: {
      sentinel: { status: 'failed', retryable: true }, worktree: { status: 'held' },
    } });
    await expect(readCompletionData(record, reference)).rejects.toThrow('completion-data-size-changed');
  });

  it('publishes replay bytes in the canonical run directory after cold index initialization', async () => {
    fixture.indexReady = false;
    const record = await saved();
    const value = { task: { id: task.id }, effectiveSuccess: true };
    const reference = await storeCompletionData(record, 'replay', value);
    const persisted = JSON.parse(await readFile(join(fixture.runRoot, record.id, 'completion', `replay-${reference.sha256}.json`), 'utf8'));
    expect(persisted).toMatchObject({ agentId: record.id, kind: 'replay', value });
    expect(await readCompletionData(record, reference)).toEqual(value);
  });

  it('retains the marker if durable continuation persistence fails', async () => {
    fixture.failWrite = true;
    await expect(finish()).rejects.toThrow('synthetic durable write failure');
    expect(await readFile(marker, 'utf8')).toContain('original payload');
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
  });

  it('keeps a service cleanup warning pending rather than treating a queued recovery as retirement', async () => {
    cleanupAgentWorktree.mockResolvedValue(['CI failed; original branch and checkout retained']);
    await finish();
    expect((await saved()).metadata.completionCleanup).toMatchObject({ status: 'pending', stages: { worktree: { status: 'held' } } });
  });

  it('rechecks a held checkout immediately after release without replaying completed handoffs', async () => {
    cleanupAgentWorktree.mockResolvedValueOnce(['Original execution still owns the checkout']).mockResolvedValue([]);
    await finish();
    const held = await saved();
    expect(held.metadata.completionCleanup.stages.worktree).toMatchObject({ status: 'held', retryable: false });
    const handoffs = updateTask.mock.calls.length;
    await Promise.all([replayAgentCompletionCleanup(held), replayAgentCompletionCleanup(held)]);
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(2);
    expect(updateTask).toHaveBeenCalledTimes(handoffs);
    expect((await saved()).metadata.completionCleanup).toMatchObject({ status: 'completed', stages: { worktree: { status: 'done' } } });
    await replayAgentCompletionCleanup(await saved());
    expect(cleanupAgentWorktree).toHaveBeenCalledTimes(2);
  });

  it('never acknowledges a replacement or sends its checkout to cleanup', async () => {
    await writeFile(marker, 'replacement generation');
    await finish();
    expect(await readFile(marker, 'utf8')).toBe('replacement generation');
    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect((await saved()).metadata.completionCleanup).toMatchObject({ status: 'pending', stages: {
      sentinel: { status: 'held' }, worktree: { status: 'held', reason: 'completion-sentinel-generation-pending' },
    } });
  });
});
