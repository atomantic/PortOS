import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

import { mkdir, rm, writeFile, readFile, mkdtemp, rename } from 'fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'fs';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../lib/mockPathsDataRoot.js';

const mockCosState = vi.hoisted(() => ({
  // Use $TMPDIR (falls back to /tmp) rather than a hardcoded /private/tmp — the
  // latter exists on macOS (where /tmp symlinks to it) but not on Linux CI,
  // where `mkdir(recursive)` then tries to create `/private` at the root and
  // hits EACCES. process.env is safe to read inside a vi.hoisted factory
  // (imported bindings like `os.tmpdir` are not yet initialized at hoist time).
  agentsDir: `${process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp'}/portos-cos-agents-test-${process.pid}`,
  state: null
}));

vi.mock('./cosState.js', () => ({
  AGENTS_DIR: mockCosState.agentsDir,
  loadState: vi.fn(async () => mockCosState.state),
  saveState: vi.fn(),
  withStateLock: async (fn) => fn(),
  // The uncached, non-defaulting read the update gate uses. Defaults to
  // "trusted, and these are the records"; one test drives the untrusted answer.
  readAgentsStateForSafetyCheck: vi.fn(async () => ({ trusted: true, agents: mockCosState.state?.agents ?? {} })),
}));

vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionPolicies: vi.fn(async () => Object.values(mockCosState.state?.agents || {})) }));
const recoveryTasks = vi.hoisted(() => new Map());
const releaseHandoff = vi.hoisted(() => ({ ensure: vi.fn(async () => ({ taskId: 'task-release-sync-example' })) }));
vi.mock('./releaseSynchronization.js', () => ({ ensureReleaseSynchronization: releaseHandoff.ensure,
  readReleaseSynchronizationRetention: vi.fn(async () => []) }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'fixture-local'), UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./cosTaskStore.js', () => ({
  getTaskById: vi.fn(async id => recoveryTasks.get(id) || null),
  getTaskView: vi.fn(async () => ({ user: { tasks: [...recoveryTasks.values()] }, cos: { tasks: [] } })),
}));

vi.mock('./domainUsage.js', () => ({
  recordDomainUsage: vi.fn(async () => {})
}));

vi.mock('./completedCheckoutEvidence.js', async original => ({ ...await original(), captureCompletedCheckouts: vi.fn(async () => []), captureCheckoutSeeds: vi.fn(async () => [{ synthetic: true }]) }));

// Pass-through fs shim with opt-in failure injection, so one test can force the
// archive's cross-filesystem fallback AND a failure partway through its copy.
// Scoped to paths inside a `YYYY-MM-DD` bucket so the flat-dir writes that
// precede the move still succeed. Off for every other test in this file.
const fsFailures = vi.hoisted(() => ({ dateBucketWritesFail: false, rmFailsFor: null }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const { relative } = await import('node:path');
  // Accept either separator: the archive path is composed with path.join, so on
  // Windows the date bucket reads '\2026-08-14\' and a '/'-only pattern never
  // matched — the injected failure never fired and completeAgent RESOLVED,
  // making this rollback test assert nothing.
  const failsFor = (p) => {
    const target = relative(mockCosState.agentsDir, String(p));
    return fsFailures.dateBucketWritesFail && /^\d{4}-\d{2}-\d{2}[\\/]/.test(target);
  };
  return {
    ...actual,
    rename: async (from, to, ...rest) => {
      if (failsFor(to)) throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
      return actual.rename(from, to, ...rest);
    },
    // Opt-in: rm of any path containing `fsFailures.rmFailsFor` rejects (EBUSY),
    // so deleteAgent's directory cleanup failure can be observed.
    rm: async (target, ...rest) => {
      if (fsFailures.rmFailsFor && String(target).includes(fsFailures.rmFailsFor)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return actual.rm(target, ...rest);
    },
    // The archive fallback copies with `cp`; the destination dir is created
    // before the failure so the rollback has a half-copied target to remove.
    cp: async (from, to, ...rest) => {
      if (failsFor(to)) {
        await actual.mkdir(to, { recursive: true });
        throw new Error('simulated copy failure');
      }
      return actual.cp(from, to, ...rest);
    }
  };
});

vi.mock('./cosRunnerClient.js', () => ({
  getActiveAgentsFromRunner: vi.fn().mockResolvedValue([]),
  requestSecurityScanViaRunner: vi.fn(),
}));

// `deleteAgent` / `completeAgent` route through `withBackupAssetPublication`,
// whose admission lease lives under `PATHS.data` (lib/backupSharedAdmission.js).
// Redirect PATHS so that lease is minted in an OS temp dir. Without it, a
// checkout nested under the install's `data/` (a CoS claim worktree) resolves
// `PATHS.data` to its own `data/`, and the real-data write guard refuses the
// admission write. The temp root is lazy because this file imports its SUT
// statically and `vi.mock` is hoisted above any `const` here.
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-cos-lifecycle-'),
}));

import { getAgent, getAgentPrompt, createAgentOutputBatcher, completeAgent, recordCompletionCleanup, recordInheritedCheckoutRetirement, recordSeededCheckoutRetirement, recordSuccessorCheckoutRetirement, settleAbsentTaskCompletion, retryCompletionCheckoutCapture, recordRepoStateVerification, reserveRepoCleanupRecovery, recordRepoCleanupRecovery, recordCleanupOutcome, recordSwarmCleanupDelivery, updateAgent, registerAgent, cleanupZombieAgents, filterLiveAgentIds, readAgentRecordOrUnreadable, deleteAgent, AGENT_RECORD_UNREADABLE, AGENT_OUTPUT_TAIL_LINES } from './cosAgentLifecycle.js';
import { saveState, loadState, readAgentsStateForSafetyCheck } from './cosState.js';
import { recordDomainUsage } from './domainUsage.js';
import { cosEvents } from './cosEvents.js';
import { loadAgentIndex } from './cosAgentIndex.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { getActiveAgentsFromRunner, requestSecurityScanViaRunner } from './cosRunnerClient.js';
import { persistAgentSecurityScan } from './agentSecurityScan.js';
import { captureCompletedCheckouts, captureCheckoutSeeds, completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { activeAgents, runnerAgents, completingAgents, spawningTasks } from './agentState.js';

afterAll(cleanupTempDataRoots);

describe('deferred delivery receipt result', () => {
  afterEach(async () => { await rm(mockCosState.agentsDir, { recursive: true, force: true }); });
  const fixture = () => ({ id: 'receipt-result', status: 'completed', startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z', result: { success: false, executionSuccess: true,
      cleanupPending: true, deliveryRecoveryOwned: true,
      taskOutcome: { status: 'incomplete', reason: 'cleanup pending', recovery: { mode: 'cleanup' } } },
    metadata: { checkoutCapture: { status: 'captured' }, repoStateVerification: { status: 'completed' },
      cleanupOutcome: { status: 'verified', unresolved: 0, committedIntegrationVerified: true },
      completionCleanup: { version: 1, status: 'completed', stages: Object.fromEntries(
        ['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report', 'worktree'].map(key => [key, { status: 'done' }])) } } });

  it.each(['matching', 'new-dispatch', 'active-owner', 'changed-capture'])(
    'records swarm delivery proof only for the same released dispatch: %s', async scenario => {
      const agent = fixture();
      agent.taskId = 'task-swarm-proof';
      agent.metadata.repoStateVerification = { status: 'pending' };
      agent.metadata.cleanupOutcome = { status: 'blocked', unresolved: 1 };
      const branch = 'claim/issue-42', head = 'a'.repeat(40), start = agent.startedAt;
      const task = { id: agent.taskId, taskType: 'internal', status: 'in_progress', metadata: {
        app: 'app', analysisType: 'claim-issue', perpetual: true, claimFlow: true, swarmCount: 2,
        claimedBy: 'fixture-local', claimedAt: start, lastSpawnedAt: start, totalSpawnCount: 1,
        deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agent.id, taskOutcome: agent.result.taskOutcome,
      } };
      Object.assign(agent.metadata, { instanceId: 'fixture-local', taskApp: 'app', taskAnalysisType: 'claim-issue', configClaimFlow: true,
        isWorktree: false, workspacePath: '/repo', claimBranches: [branch], claimReleasedBranches: [],
        completionTaskDispatch: { taskId: task.id, taskType: 'internal', expected: [
          ['claimedBy', 'fixture-local'], ['claimedAt', start], ['lastSpawnedAt', start], ['totalSpawnCount', 1],
        ] }, completedCheckouts: [{ version: 1, agentId: agent.id, startedAt: start, capturedAt: start,
          repoPath: '/repo', path: '/tree', branch, head, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } }] });
      const expected = structuredClone(agent);
      const proof = { version: 1, branches: [{ branch, head, prUrl: 'https://github.com/a/b/pull/42' }] };
      if (scenario === 'new-dispatch') task.metadata.totalSpawnCount = 2;
      if (scenario === 'changed-capture') agent.metadata.completedCheckouts[0].head = 'b'.repeat(40);
      mockCosState.state = { agents: { [agent.id]: agent } };
      if (scenario === 'active-owner') mockCosState.state.agents.rival = { id: 'rival', taskId: task.id, status: 'running' };
      recoveryTasks.set(task.id, task);
      try {
        expect(await recordSwarmCleanupDelivery(agent.id, expected, proof)).toBe(scenario === 'matching');
        expect(Boolean(mockCosState.state.agents[agent.id].metadata.swarmCleanupDelivery)).toBe(scenario === 'matching');
        expect(task.status).toBe('in_progress');
      } finally { recoveryTasks.delete(task.id); }
    });

  it('persists settled delivery in live and archived records without re-emitting completion', async () => {
    const agent = fixture();
    agent.metadata.runId = 'receipt-run';
    const tracking = await import('./agentRunTracking.js');
    const reconcileRun = vi.spyOn(tracking, 'reconcileAgentRunDelivery').mockResolvedValue(true);
    mockCosState.state = { agents: { [agent.id]: agent } };
    const directory = join(mockCosState.agentsDir, agent.completedAt.slice(0, 10), agent.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(agent));
    const completed = vi.fn(); cosEvents.on('agent:completed', completed);
    try {
      await recordRepoStateVerification(agent.id, { status: 'completed' });
      const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
      expect(saved.result).toMatchObject({ success: true, executionSuccess: true, cleanupPending: false,
        taskOutcome: { status: 'completed' }, deferredDeliveryOutcome: agent.result.taskOutcome });
      expect(mockCosState.state.agents[agent.id].result).toEqual(saved.result);
      delete mockCosState.state.agents[agent.id];
      await recordRepoStateVerification(agent.id, { status: 'completed' });
      expect(JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')).result).toEqual(saved.result);
      expect(reconcileRun).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ success: true }),
        metadata: expect.objectContaining({ runId: 'receipt-run' }) }));
      expect(completed).not.toHaveBeenCalled();
    } finally { cosEvents.off('agent:completed', completed); reconcileRun.mockRestore(); }
  });

  it.each(['execution', 'validation', 'unknown-capture', 'pending-stage', 'unresolved-payload', 'unverified-integration', 'original-failure'])(
    'preserves %s instead of manufacturing success', async kind => {
      const agent = fixture();
      if (kind === 'execution') agent.result.executionSuccess = false;
      if (kind === 'validation') agent.result.validationPassed = false;
      if (kind === 'unknown-capture') agent.metadata.checkoutCapture = { status: 'pending', unknown: true };
      if (kind === 'pending-stage') agent.metadata.completionCleanup.stages.worktree.status = 'held';
      if (kind === 'unresolved-payload') agent.metadata.cleanupOutcome.unresolved = 1;
      if (kind === 'unverified-integration') agent.metadata.cleanupOutcome.committedIntegrationVerified = false;
      if (kind === 'original-failure') delete agent.result.cleanupPending;
      mockCosState.state = { agents: { [agent.id]: agent } };
      await recordRepoStateVerification(agent.id, { status: 'completed' });
      expect(mockCosState.state.agents[agent.id].result).toEqual(agent.result);
    });
});

describe('cosAgentLifecycle', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {} };
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([]);
    activeAgents.clear();
    runnerAgents.clear();
  });

  afterEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('bounds original-parent recoveries across 70 scans, evidence cycles, active ownership and restart', async () => {
    const id = 'agent-recovery-history';
    mockCosState.state.agents[id] = { id, status: 'completed', completedAt: '2026-01-01T00:00:00Z', metadata: {} };
    expect(await reserveRepoCleanupRecovery(id, 'claim/one', 'A')).toMatchObject({ admitted: true, attempt: 1 });
    for (let i = 0; i < 70; i++) expect(await reserveRepoCleanupRecovery(id, 'claim/one', 'B')).toMatchObject({ admitted: false, reason: 'cleanup-publication-unverified' });
    await recordRepoCleanupRecovery(id, 'claim/one', 'A', { phase: 'dispatched', taskId: 'successor-1' });
    recoveryTasks.set('successor-1', { status: 'in_progress' });
    expect(await reserveRepoCleanupRecovery(id, 'claim/one', 'B')).toMatchObject({ admitted: false, reason: 'cleanup-successor-owned' });
    recoveryTasks.set('successor-1', { status: 'completed' });
    expect(await reserveRepoCleanupRecovery(id, 'claim/one', 'B')).toMatchObject({ admitted: true, attempt: 2 });
    await recordRepoCleanupRecovery(id, 'claim/one', 'B', { phase: 'dispatched', taskId: 'successor-2' });
    recoveryTasks.set('successor-2', { status: 'completed' });
    // Reconstruct persisted state; neither the old parent's empty recoveryOrigin
    // nor a process restart resets this history or the total attempt budget.
    mockCosState.state = JSON.parse(JSON.stringify(mockCosState.state));
    for (let i = 0; i < 70; i++) expect(await reserveRepoCleanupRecovery(id, 'claim/one', 'A')).toMatchObject({ admitted: false, reason: 'cleanup-observation-already-attempted' });
    expect(await reserveRepoCleanupRecovery(id, 'claim/one', 'C')).toMatchObject({ admitted: true, attempt: 3 });
    await recordRepoCleanupRecovery(id, 'claim/one', 'C', { phase: 'dispatched', taskId: 'successor-3' });
    recoveryTasks.set('successor-3', { status: 'completed' });
    expect(await reserveRepoCleanupRecovery(id, 'claim/one', 'D')).toMatchObject({ admitted: false, reason: 'cleanup-cognitive-budget-exhausted' });
    expect(mockCosState.state.agents[id].metadata.repoCleanupRecoveries['claim/one'].observations).toEqual(['A', 'B', 'C']);
  });

  it.each(['automatic-retirement-paused', 'review-obligation-changed'])('resumes known-unexecuted %s deferrals without resetting real attempts', async reason => {
    const id = 'agent-deferred-review';
    mockCosState.state.agents[id] = { id, status: 'completed', metadata: {} };
    expect(await reserveRepoCleanupRecovery(id, 'fix/work', 'prior')).toMatchObject({ admitted: true, attempt: 1 });
    await recordRepoCleanupRecovery(id, 'fix/work', 'prior', { phase: 'dispatched', taskId: 'completed-review' });
    recoveryTasks.set('completed-review', { status: 'completed' });
    for (let i = 0; i < 70; i++) {
      expect(await reserveRepoCleanupRecovery(id, 'fix/work', 'current')).toMatchObject({ admitted: true, attempt: 2 });
      await recordRepoCleanupRecovery(id, 'fix/work', 'current', { phase: 'blocked-before-dispatch', taskId: null, reason });
      mockCosState.state = JSON.parse(JSON.stringify(mockCosState.state));
    }
    expect(mockCosState.state.agents[id].metadata.repoCleanupRecoveries['fix/work']).toMatchObject({ attempt: 1, observations: ['prior'] });
    expect(await reserveRepoCleanupRecovery(id, 'fix/work', 'prior')).toMatchObject({ admitted: false, reason: 'cleanup-observation-already-attempted' });
    expect(await reserveRepoCleanupRecovery(id, 'fix/work', 'current')).toMatchObject({ admitted: true, attempt: 2 });
    await recordRepoCleanupRecovery(id, 'fix/work', 'current', { phase: 'dispatched', taskId: 'active-review' });
    recoveryTasks.set('active-review', { status: 'in_progress' });
    expect(await reserveRepoCleanupRecovery(id, 'fix/work', 'changed')).toMatchObject({ admitted: false, reason: 'cleanup-successor-owned' });
  });

  it('replaces provisional owner holds when the original checkout completes without hiding other paths', async () => {
    const id = 'agent-owner-completion';
    mockCosState.state.agents[id] = { id, status: 'completed', metadata: {} };
    await recordCleanupOutcome(id, { branch: 'claim/one', status: 'blocked', reason: 'owner-active' });
    await recordCleanupOutcome(id, { branch: 'claim/other', path: '/example/other', status: 'blocked', reason: 'archive-unavailable' });
    await recordCleanupOutcome(id, { branch: 'claim/one', path: '/example/original', status: 'verified', reason: 'retirement-receipt-verified' });
    expect(mockCosState.state.agents[id].metadata.cleanupOutcome).toMatchObject({ status: 'blocked', total: 2, unresolved: 1, branch: 'claim/other' });
    await recordCleanupOutcome(id, { branch: 'claim/other', path: '/example/new-incarnation', status: 'verified', reason: 'retirement-receipt-verified' });
    expect(mockCosState.state.agents[id].metadata.cleanupOutcome).toMatchObject({ status: 'blocked', total: 3, unresolved: 1 });
    await recordCleanupOutcome(id, { branch: 'claim/other', path: '/example/other', status: 'verified', reason: 'retirement-receipt-verified' });
    expect(mockCosState.state.agents[id].metadata.cleanupOutcome).toMatchObject({ status: 'verified', unresolved: 0 });
  });

  it.each([true, false])('aggregates every branch outcome independently of update order (%s)', async reversed => {
    const id = 'agent-swarm-outcome';
    mockCosState.state.agents[id] = { id, status: 'completed', metadata: {} };
    const rows = [{ branch: 'claim/blocked', path: '/example/blocked', status: 'blocked', reason: 'checkout-incarnation-changed' },
      { branch: 'claim/verified', path: '/example/verified', status: 'verified', reason: 'retirement-receipt-verified' }];
    for (const row of reversed ? rows.reverse() : rows) await recordCleanupOutcome(id, row);
    expect(mockCosState.state.agents[id].metadata.cleanupOutcome).toMatchObject({ status: 'blocked', unresolved: 1, total: 2 });
    expect(Object.values(mockCosState.state.agents[id].metadata.cleanupOutcomes)).toHaveLength(2);
  });

  it('archives interrupted audit findings before removing their workspace and reloads them after live retention', async () => {
    const { settleAuditFindings } = await import('./auditFindings.js');
    const workspace = join(mockCosState.agentsDir, 'audit-workspace');
    await mkdir(workspace);
    mockCosState.state.stats = { agentsSpawned: 0, agentsCompleted: 0, agentsFailed: 0 };
    await registerAgent('agent-disposition', 'task-example', { taskAnalysisType: 'security', auditDispositionVersion: 1 });
    const report = { version: 1, findings: [{ key: 'example-authority', title: 'Example boundary', path: 'server/routes/example.js',
      severity: 8, confidence: 'high', classification: 'actionable', evidence: 'Synthetic mounted route bypass.',
      disposition: { kind: 'unresolved', reason: 'Tracker unavailable.' } }] };
    await writeFile(join(workspace, '.agent-audit-findings-agent-disposition.json'), JSON.stringify(report));
    const disposition = await settleAuditFindings({ agentId: 'agent-disposition', workspacePath: workspace,
      task: { metadata: { auditDispositionVersion: '1', analysisType: 'security' } } });
    await completeAgent('agent-disposition', { success: false, auditDisposition: disposition });
    await rm(workspace, { recursive: true });
    delete mockCosState.state.agents['agent-disposition'];
    const archived = await getAgent('agent-disposition');
    expect(archived.metadata.auditFindings.report).toEqual(report);
    expect(archived.result.auditDisposition.status).toBe('incomplete');
  });

  it('keeps trusted terminal scanner receipts across stale reconnects, agent claims and missing completion', async () => {
    mockCosState.state.stats = { agentsSpawned: 0, agentsCompleted: 0, agentsFailed: 0 };
    await registerAgent('agent-scanner', 'task-example', { taskAnalysisType: 'security', useRunner: true });
    const evidence = { version: 1, source: 'runner', sequence: 3, status: 'refused', model: 'example-model', effort: 'medium', auth: 'chatgpt',
      maxCostUsd: 2, estimatedCostUsd: null, timeLimitSeconds: 180, exitCode: 143,
      artifacts: { findings: false, coverage: false }, cleanup: 'confirmed',
      preflight: { rejectedRequests: 1, lastError: { field: 'paths', index: 0, code: 'path-not-found' } } };
    await persistAgentSecurityScan('agent-scanner', { ...evidence, sequence: 1, status: 'invalid-input', exitCode: null, cleanup: 'not-needed' });
    expect((await getAgent('agent-scanner')).metadata.securityScan).toMatchObject({ status: 'invalid-input', preflight: evidence.preflight });
    await persistAgentSecurityScan('agent-scanner', evidence);
    await persistAgentSecurityScan('agent-scanner', { ...evidence, sequence: 2, status: 'running', exitCode: null });
    await updateAgent('agent-scanner', { metadata: { securityScan: { ...evidence, source: 'agent-report', status: 'completed', exitCode: 0 } } });
    vi.mocked(requestSecurityScanViaRunner).mockResolvedValue({ evidence });
    await completeAgent('agent-scanner', { success: true });
    const agent = await getAgent('agent-scanner');
    expect(agent.metadata.securityScan).toEqual(evidence);
    expect(agent.metadata.executionInterruption.category).toBe('content-refusal');
    expect(agent.result.success).toBe(false);
    expect(agent.result.error).toContain('safety refusal');
  });

  it('records uncertain cleanup if the runner disappears before outer completion', async () => {
    mockCosState.state.stats = { agentsSpawned: 0, agentsCompleted: 0, agentsFailed: 0 };
    await registerAgent('agent-scanner', 'task-example', { taskAnalysisType: 'security', useRunner: true });
    await persistAgentSecurityScan('agent-scanner', { version: 1, source: 'runner', sequence: 3, status: 'running', model: 'example-model', effort: 'medium', auth: 'chatgpt',
      maxCostUsd: 2, estimatedCostUsd: null, timeLimitSeconds: 180, exitCode: null,
      artifacts: { findings: null, coverage: null }, cleanup: 'unconfirmed' });
    vi.mocked(requestSecurityScanViaRunner).mockRejectedValue(new Error('synthetic runner loss'));
    await completeAgent('agent-scanner', { success: false, error: 'Terminated' });
    expect((await getAgent('agent-scanner')).metadata).toMatchObject({ securityScan: { sequence: 3, status: 'running', exitCode: null }, securityScanControl: { status: 'interrupted', cleanup: 'unconfirmed' } });
    const observed = (await getAgent('agent-scanner')).metadata.securityScan;
    await persistAgentSecurityScan('agent-scanner', { ...observed, sequence: 2, status: 'invalid-input', cleanup: 'not-needed',
      preflight: { rejectedRequests: 1, lastError: { field: 'paths', index: 0, code: 'path-not-found' } } });
    expect((await getAgent('agent-scanner')).metadata).toMatchObject({ securityScan: { sequence: 3, status: 'running' }, securityScanControl: { status: 'interrupted', cleanup: 'unconfirmed' } });
    await persistAgentSecurityScan('agent-scanner', { ...observed, sequence: 4, status: 'refused', exitCode: 143, cleanup: 'confirmed' });
    expect((await getAgent('agent-scanner')).metadata).toMatchObject({ securityScan: { status: 'refused', cleanup: 'confirmed' }, securityScanControl: null });
  });

  it('keeps archived prompts readable after state eviction, with UTF-8 byte counts', async () => {
    const id = 'agent-archived-prompt';
    const date = '2026-01-01';
    const dir = join(mockCosState.agentsDir, date, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, status: 'completed', completedAt: `${date}T12:00:00Z` }));
    await writeFile(join(dir, 'prompt.txt'), 'Example café');
    (await loadAgentIndex()).set(id, date);
    await expect(getAgentPrompt(id)).resolves.toEqual({ prompt: 'Example café', bytes: Buffer.byteLength('Example café') });
  });

  it('hydrates paused agents with full preserved output from output.txt', async () => {
    const agentId = 'agent-paused';
    const pausedAt = '2026-05-25T12:00:00.000Z';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'paused',
      pausedAt,
      output: [{ line: 'state tail only', timestamp: pausedAt }]
    };

    await mkdir(join(mockCosState.agentsDir, agentId), { recursive: true });
    await writeFile(join(mockCosState.agentsDir, agentId, 'output.txt'), 'full line one\nfull line two\n');

    const agent = await getAgent(agentId);

    expect(agent.status).toBe('paused');
    expect(agent.output).toEqual([
      { line: 'full line one', timestamp: pausedAt },
      { line: 'full line two', timestamp: pausedAt }
    ]);
    expect(agent.outputTruncated).toBe(false);
  });

  // The predicate behind the "CoS agents running" update gate. Its whole job is
  // to keep the two failure directions apart: a tracked id whose run PortOS has
  // already finalized must not block a restart forever, and a genuinely live one
  // must still block it.
  it('narrows tracked ids to live records, dropping finalized and unknown ones', async () => {
    mockCosState.state.agents = {
      'agent-running': { id: 'agent-running', status: 'running' },
      // A paused agent is still owed a resume, so its record stays live.
      'agent-paused': { id: 'agent-paused', status: 'paused' },
      'agent-done': { id: 'agent-done', status: 'completed', completedAt: '2026-05-25T12:00:00.000Z' }
    };

    await expect(filterLiveAgentIds([
      'agent-running', 'agent-running', 'agent-paused', 'agent-done', 'agent-archived-away'
    ])).resolves.toEqual(['agent-running', 'agent-paused']);
    await expect(filterLiveAgentIds([])).resolves.toEqual([]);
  });

  // The gate this feeds authorizes a pm2 restart that severs live agents, so an
  // unreadable state file must not read as "nothing is running". `loadState`
  // substitutes an EMPTY default state for a corrupt file — trusting that would
  // hand the gate a confident zero and restart PortOS out from under whatever
  // was live.
  it('treats every tracked id as live when the records cannot be established', async () => {
    vi.mocked(readAgentsStateForSafetyCheck).mockResolvedValueOnce({ trusted: false, agents: null });

    await expect(filterLiveAgentIds(['agent-a', 'agent-b']))
      .resolves.toEqual(['agent-a', 'agent-b']);
  });

  // "The read failed" and "there is no such record" lead to opposite decisions —
  // one leaves live tracking alone, the other retires it — so the reader must
  // never let an I/O failure arrive as a plain null.
  it('reports an unreadable record as its own sentinel, not as an absent one', async () => {
    mockCosState.state.agents = { 'agent-running': { id: 'agent-running', status: 'running' } };

    await expect(readAgentRecordOrUnreadable('agent-running'))
      .resolves.toMatchObject({ id: 'agent-running' });
    await expect(readAgentRecordOrUnreadable('agent-never-existed')).resolves.toBeNull();

    loadState.mockRejectedValueOnce(new Error('state.json unreadable'));
    await expect(readAgentRecordOrUnreadable('agent-running'))
      .resolves.toBe(AGENT_RECORD_UNREADABLE);
  });

  // #3498: output.txt is unbounded — a long TUI run writes tens of MB. Reading it
  // whole and mapping EVERY line to an object spiked heap on a single request.
  describe('transcript tail caps (#3498)', () => {
    const writeCompleted = async (agentId, completedAt, contents) => {
      mockCosState.state.agents[agentId] = { id: agentId, status: 'completed', completedAt, metadata: {}, output: [] };
      const dir = join(mockCosState.agentsDir, completedAt.slice(0, 10), agentId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'output.txt'), contents);
      return dir;
    };

    it('returns only the tail lines and flags the transcript as truncated', async () => {
      const completedAt = '2026-05-25T12:00:00.000Z';
      const contents = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
      await writeCompleted('agent-long', completedAt, contents);

      const agent = await getAgent('agent-long', { limit: 10 });

      expect(agent.output).toHaveLength(10);
      expect(agent.output[0]).toEqual({ line: 'line 4990', timestamp: completedAt });
      expect(agent.output[9]).toEqual({ line: 'line 4999', timestamp: completedAt });
      expect(agent.outputTruncated).toBe(true);
      expect(agent.outputTotalBytes).toBe(Buffer.byteLength(contents));
    });

    it('caps by BYTES too, so a newline-free TUI transcript cannot blow memory', async () => {
      // A repainted TUI screen spools as effectively one enormous line, on which
      // a line-based tail is a no-op — the byte cap is what bounds it.
      const completedAt = '2026-05-26T12:00:00.000Z';
      const contents = 'x'.repeat(200_000);
      await writeCompleted('agent-oneline', completedAt, contents);

      const agent = await getAgent('agent-oneline', { maxBytes: 1024 });

      // The leading partial line is normally dropped, but here it is the ONLY
      // content in the window — a partial last screen beats an empty transcript
      // for a file that is plainly not empty.
      expect(agent.output).toHaveLength(1);
      expect(agent.output[0].line).toBe('x'.repeat(1024));
      expect(agent.outputTruncated).toBe(true);
      expect(agent.outputTotalBytes).toBe(200_000);
    });

    it('drops the partial leading line the byte window starts mid-way through', async () => {
      const completedAt = '2026-05-27T12:00:00.000Z';
      const contents = `${'a'.repeat(50)}\nbbbb\ncccc\n`;
      await writeCompleted('agent-partial', completedAt, contents);

      const agent = await getAgent('agent-partial', { maxBytes: 20 });

      expect(agent.output.map(o => o.line)).toEqual(['bbbb', 'cccc']);
      expect(agent.outputTruncated).toBe(true);
    });

    it('applies the default caps when no options are passed', async () => {
      const completedAt = '2026-05-28T12:00:00.000Z';
      const contents = Array.from({ length: AGENT_OUTPUT_TAIL_LINES + 500 }, (_, i) => `line ${i}`).join('\n');
      await writeCompleted('agent-default', completedAt, contents);

      const agent = await getAgent('agent-default');

      expect(agent.output).toHaveLength(AGENT_OUTPUT_TAIL_LINES);
      expect(agent.outputTruncated).toBe(true);
    });

    it('leaves the record untouched when output.txt is missing', async () => {
      const completedAt = '2026-05-29T12:00:00.000Z';
      mockCosState.state.agents['agent-nofile'] = { id: 'agent-nofile', status: 'completed', completedAt, metadata: {}, output: [] };
      await mkdir(join(mockCosState.agentsDir, '2026-05-29', 'agent-nofile'), { recursive: true });

      const agent = await getAgent('agent-nofile');

      expect(agent.output).toEqual([]);
      expect(agent).not.toHaveProperty('outputTruncated');
    });
  });

  it('persists post-completion metadata updates in the archived agent record', async () => {
    const agentId = 'agent-completed';
    const completedAt = '2026-05-25T12:00:00.000Z';
    mockCosState.state.agents[agentId] = { id: agentId, status: 'completed', completedAt, metadata: {}, output: [] };
    const archiveDir = join(mockCosState.agentsDir, '2026-05-25', agentId);
    await mkdir(archiveDir, { recursive: true });

    await updateAgent(agentId, { metadata: { malwareScan: { verdict: 'DANGEROUS' } } });

    const persisted = JSON.parse(await readFile(join(archiveDir, 'metadata.json'), 'utf8'));
    expect(persisted.metadata.malwareScan.verdict).toBe('DANGEROUS');
  });

  it('publishes saved cleanup diagnostics for an archived owner without reviving execution', async () => {
    const id = 'agent-archived-cleanup';
    const date = '2026-01-01';
    const record = { id, status: 'completed', completedAt: `${date}T12:00:00Z`, metadata: {} };
    const directory = join(mockCosState.agentsDir, date, id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(record));
    (await loadAgentIndex()).set(id, date);
    const observed = [];
    const listener = agent => {
      if (agent.id === id) observed.push(agent);
    };
    cosEvents.on('agent:updated', listener);
    try {
      await recordCleanupOutcome(id, { status: 'blocked', reason: 'preservation-unverified' });
      const persisted = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
      expect(observed).toEqual([persisted]);
      expect(observed[0]).toMatchObject({ status: 'completed', metadata: { cleanupOutcome: { reason: 'preservation-unverified' } } });
      expect(mockCosState.state.agents[id]).toBeUndefined();
    } finally {
      cosEvents.off('agent:updated', listener);
    }
  });
});

describe('completeAgent budget-ledger ordering (#1683)', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {}, stats: { tasksCompleted: 0, errors: 0 } };
    recordDomainUsage.mockClear();
  });

  afterEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    cosEvents.removeAllListeners('agent:completed');
  });

  it.each([
    ['scheduled', { taskType: 'scheduled' }],
    ['on-demand', { taskType: 'internal', onDemand: true }],
  ])('records %s action usage BEFORE emitting agent:completed', async (_kind, metadata) => {
    // The agent:completed handler schedules dequeueNextTask(), whose daily
    // action-budget gate reads the usage ledger. If the emit beats the ledger
    // write, the gate counts stale usage and can admit one spawn past the cap.
    const order = [];
    recordDomainUsage.mockImplementation(async () => { order.push('usage'); });
    cosEvents.on('agent:completed', () => { order.push('completed'); });

    const agentId = 'agent-autonomous';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata
    };

    await completeAgent(agentId, { success: true, duration: 1200 });

    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1, ms: 1200 });
    expect(order).toEqual(['usage', 'completed']);
  });

  it('archives a publisher only after its durable continuation is confirmed', async () => {
    const publication = { status: 'verified', synchronizationHandoffVersion: 1, identity: 'a'.repeat(64), publishedAt: '2026-01-01T00:00:00Z' };
    const agent = { id: 'agent-publisher', taskId: 'task-example-release', status: 'running',
      startedAt: '2026-01-01T00:00:00Z', metadata: { taskAnalysisType: 'do-release', releasePublication: publication } };
    mockCosState.state.agents[agent.id] = agent;
    releaseHandoff.ensure.mockRejectedValueOnce(new Error('synthetic handoff unavailable'));
    await expect(completeAgent(agent.id, { success: true })).rejects.toThrow('handoff unavailable');
    expect(mockCosState.state.agents[agent.id].status).toBe('running');
    const completed = await completeAgent(agent.id, { success: true });
    expect(completed.status).toBe('completed');
    expect(completed.metadata.releasePublication).toEqual(publication);
    expect(releaseHandoff.ensure).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id, taskId: agent.taskId }));
  });

  it('refuses enrollment racing a completion that only observed the legacy receipt', async () => {
    const id = 'agent-publication-race';
    mockCosState.state.agents[id] = { id, taskId: 'task-example-release', status: 'running', startedAt: '2026-01-01T00:00:00Z',
      metadata: { taskAnalysisType: 'do-release', releasePublication: { status: 'verified', identity: 'b'.repeat(64) } } };
    loadState.mockImplementationOnce(async () => {
      const legacy = structuredClone(mockCosState.state);
      mockCosState.state.agents[id].metadata.releasePublication.synchronizationHandoffVersion = 1;
      return legacy;
    });
    await expect(completeAgent(id, { success: true })).rejects.toThrow('handoff ownership changed');
    expect(mockCosState.state.agents[id].status).toBe('running');
  });

  it('retains delivery outcome through archive storage and list projection without changing feedback', async () => {
    const { toAgentListItem } = await import('../lib/cosAgentListProjection.js');
    const agentId = 'agent-task-outcome';
    const taskOutcome = { status: 'blocked', reason: 'Invented prerequisite missing.' };
    const feedback = { rating: 'positive', comment: 'Original feedback.' };
    mockCosState.state.agents[agentId] = { id: agentId, status: 'running', metadata: {}, feedback };
    const completed = await completeAgent(agentId, { success: false, executionSuccess: true, taskOutcome });
    const archived = JSON.parse(await readFile(join(mockCosState.agentsDir, completed.completedAt.slice(0, 10), agentId, 'metadata.json'), 'utf8'));
    expect(toAgentListItem(archived)).toMatchObject({ result: { success: false, executionSuccess: true, taskOutcome }, feedback });
  });

  it('still emits agent:completed when the usage-ledger write rejects', async () => {
    // recordDomainUsage is .catch-guarded, so a ledger-write failure must not
    // swallow the completion event — the scheduler still needs to advance.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordDomainUsage.mockRejectedValueOnce(new Error('ledger disk full'));

    const agentId = 'agent-ledger-fail';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' }
    };
    let emitted = false;
    cosEvents.on('agent:completed', () => { emitted = true; });

    await completeAgent(agentId, { success: true, duration: 500 });

    expect(emitted).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to record CoS budget usage for ${agentId}`)
    );
    consoleSpy.mockRestore();
  });

  it('does not charge stats.errors for a record retired by a resume', async () => {
    // `resumeAgent` retires a PAUSED record here so it stops showing as paused. The
    // run wasn't a failure — the user paused it and its task is already requeued, so
    // the continuation lands in one of these counters itself. Counting it reports an
    // error the user caused deliberately and never saw.
    mockCosState.state.agents['agent-resumed'] = {
      id: 'agent-resumed', status: 'paused', metadata: { taskType: 'user' }
    };
    mockCosState.state.agents['agent-failed'] = {
      id: 'agent-failed', status: 'running', metadata: { taskType: 'user' }
    };

    await completeAgent('agent-resumed', { success: false, resumed: true, resumedTaskId: 'task-abc' });
    expect(mockCosState.state.stats.errors).toBe(0);
    expect(mockCosState.state.agents['agent-resumed'].status).toBe('completed');

    // An ordinary failure still counts.
    await completeAgent('agent-failed', { success: false, exitCode: 1 });
    expect(mockCosState.state.stats.errors).toBe(1);
  });

  it('skips usage accounting for user tasks but still emits agent:completed', async () => {
    const agentId = 'agent-user';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'user' }
    };
    let emitted = false;
    cosEvents.on('agent:completed', () => { emitted = true; });

    await completeAgent(agentId, { success: true });

    expect(recordDomainUsage).not.toHaveBeenCalled();
    expect(emitted).toBe(true);
  });
});

describe('completeAgent idempotence (#3384)', () => {
  const emittedCompletions = [];
  const seedBodies = ownTestBodies(it);

  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {}, stats: { tasksCompleted: 0, errors: 0 } };
    emittedCompletions.length = 0;
    recordDomainUsage.mockClear();
    recordDomainUsage.mockImplementation(async () => {});
    captureCompletedCheckouts.mockReset().mockResolvedValue([]);
    cosEvents.on('agent:completed', (agent) => emittedCompletions.push(agent));
  });

  afterEach(async () => {
    // Bail settles Vitest's wrapper before its body: retain fixtures and spies
    // until the seed's Git work, completion/retry and finally have all finished.
    try {
      await seedBodies.drain();
    } finally {
      fsFailures.dateBucketWritesFail = false;
      await rm(mockCosState.agentsDir, { recursive: true, force: true });
      cosEvents.removeAllListeners('agent:completed');
    }
  });

  it.each([{ success: true, pinned: false }, { success: false, pinned: false }, { success: true, pinned: true }, { success: false, pinned: true }])('archives checkout evidence before releasing a delivered or cleanup-pending claim ($success, pinned=$pinned)', async ({ success, pinned }) => {
    const agentId = 'claim-completion';
    const receipt = { version: 1, agentId, branch: 'claim/issue-1' };
    mockCosState.state.agents[agentId] = { id: agentId, status: 'running', startedAt: '2026-01-01T00:00:00Z',
      metadata: { claimPicksOwnBranch: !pinned, ...(pinned ? { claimBranch: receipt.branch } : {}), claimBranches: [receipt.branch] }, output: [] };
    captureCompletedCheckouts.mockImplementationOnce(async agent => {
      expect(agent.status).toBe('running');
      expect(mockCosState.state.agents[agentId].status).toBe('running');
      return [receipt];
    });
    const result = await completeAgent(agentId, { success, cleanupPending: !success });
    expect(result.result.success).toBe(success);
    expect(result.metadata.repoStateVerification.status).toBe('pending');
    expect(result.metadata.completionCleanup).toMatchObject({ status: 'abandoned', reason: 'completion-context-unavailable' });
    expect(result.metadata.completedCheckouts).toEqual([receipt]);
    const archived = JSON.parse(await readFile(join(mockCosState.agentsDir, result.completedAt.slice(0, 10), agentId, 'metadata.json'), 'utf8'));
    expect(archived.metadata.completedCheckouts).toEqual([receipt]);
    await completeAgent(agentId, { success: true });
    expect(captureCompletedCheckouts).toHaveBeenCalledTimes(1);
  });

  it('atomically persists removed-task ledger and verification settlement without changing the execution result', async () => {
    const id = 'removed-task-completion';
    const startedAt = '2026-01-01T00:00:00Z';
    const completedAt = '2026-01-01T00:01:00Z';
    const stages = Object.fromEntries(['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report']
      .map(key => [key, { status: 'done' }]));
    stages.worktree = { status: 'held' };
    const record = { id, taskId: 'removed-original', status: 'completed', startedAt, completedAt,
      result: { success: false, executionSuccess: true, cleanupPending: true }, metadata: {
        instanceId: 'fixture-local', repoStateVerification: { status: 'pending' },
        completedCheckouts: [{ branch: 'synthetic-owned-checkout', head: 'a'.repeat(40) }],
        completionCleanup: { version: 1, status: 'pending', stages,
          replay: { version: 1, kind: 'replay', bytes: 123, sha256: 'b'.repeat(64) } } } };
    mockCosState.state.agents[id] = record;
    const directory = join(mockCosState.agentsDir, completedAt.slice(0, 10), id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(record));
    const expected = structuredClone(record);
    recoveryTasks.set(record.taskId, { id: record.taskId, status: 'in_progress' });
    expect(await settleAbsentTaskCompletion(id, expected)).toBe(false);
    recoveryTasks.delete(record.taskId);
    expect(await settleAbsentTaskCompletion(id, { ...expected, metadata: { ...expected.metadata,
      completedCheckouts: [{ branch: 'different-checkout' }] } })).toBe(false);
    expect(await settleAbsentTaskCompletion(id, expected)).toBe(true);
    const persisted = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(persisted.metadata.completionCleanup).toMatchObject({ status: 'completed', stages: { worktree: { status: 'done' } } });
    expect(persisted.metadata.completionCleanup).not.toHaveProperty('replay');
    expect(persisted.metadata.repoStateVerification.status).toBe('completed');
    expect(persisted.result).toEqual(record.result);
    expect(recoveryTasks.has(record.taskId)).toBe(false);
    expect(await settleAbsentTaskCompletion(id, expected)).toBe(false);
  });

  it.each(['verified', 'refused-cas', 'wrong-head', 'wrong-generation', 'wrong-task', 'failed-validation'])(
    'persists known same-head predecessor settlement atomically: %s', async scenario => {
      const id = 'known-predecessor', startedAt = '2026-01-01T00:00:00Z', completedAt = '2026-01-01T00:01:00Z';
      const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
      const capture = { version: 1, agentId: id, startedAt, capturedAt: completedAt, head: 'a'.repeat(40),
        repoPath: '/synthetic/repo', branch: 'feature/retired', path: '/synthetic/old-path',
        incarnation: { pointer, gitdir: { ...pointer, path: '/synthetic/repo/.git/worktrees/original' } } };
      const stages = Object.fromEntries(['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report'].map(key => [key, { status: 'done' }]));
      stages.worktree = { status: 'held', reason: 'checkout-incarnation-changed' };
      const record = { id, taskId: 'same-task', status: 'completed', startedAt, completedAt,
        result: { success: false, executionSuccess: true, validationPassed: scenario === 'failed-validation' ? false : null,
          cleanupPending: true, deliveryRecoveryOwned: true,
          taskOutcome: { status: 'incomplete', reason: 'retirement pending', recovery: { mode: 'cleanup' } } },
        metadata: { sourceWorkspace: capture.repoPath, workspacePath: capture.path, worktreeBranch: capture.branch,
          reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7', branch: capture.branch },
          completedCheckouts: [capture], checkoutCapture: { status: 'captured' }, repoStateVerification: { status: 'pending' },
          cleanupOutcomes: { [JSON.stringify([capture.branch, capture.path])]: { branch: capture.branch, path: capture.path, status: 'blocked' } },
          completionCleanup: { version: 1, status: 'pending', stages, replay: { version: 1 } } } };
      mockCosState.state.agents[id] = record;
      const directory = join(mockCosState.agentsDir, completedAt.slice(0, 10), id);
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'metadata.json'), JSON.stringify(record));
      const expected = structuredClone(record);
      if (scenario === 'refused-cas') expected.metadata.changed = true;
      if (scenario === 'wrong-task') expected.taskId = 'other-task';
      const proof = { successorAgentId: 'delivered-successor', head: capture.head, prUrl: record.metadata.reviewLoopMergeTarget.url,
        checkoutIdentity: retirementCheckoutIdentityFromPointer(pointer), receiptDigest: 'b'.repeat(64), sourceCapture: structuredClone(capture) };
      if (scenario === 'wrong-head') proof.head = 'c'.repeat(40);
      if (scenario === 'wrong-generation') proof.sourceCapture.incarnation.pointer.ino = '9';
      const completion = vi.fn(); cosEvents.on('agent:completed', completion);
      try {
        expect(await recordSuccessorCheckoutRetirement(id, expected, proof)).toBe(scenario === 'verified');
        const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
        expect(saved.metadata.completedCheckouts).toEqual([capture]);
        expect(saved.metadata.checkoutCapture).toEqual({ status: 'captured' });
        if (scenario === 'verified') {
          expect(saved.result).toMatchObject({ success: true, executionSuccess: true, cleanupPending: false,
            deferredDeliveryOutcome: record.result.taskOutcome, taskOutcome: { status: 'completed' } });
          expect(saved.metadata.cleanupOutcome).toMatchObject({ status: 'verified', unresolved: 0, committedIntegrationVerified: true,
            branch: capture.branch, path: capture.path });
          expect(saved.metadata.completionCleanup.status).toBe('completed');
          expect(saved.metadata.repoStateVerification).toMatchObject({ status: 'completed', deliveryVerifiedBySuccessor: proof.successorAgentId });
          expect(await recordSuccessorCheckoutRetirement(id, expected, proof)).toBe(false);
        } else expect(saved).toEqual(record);
        expect(completion).not.toHaveBeenCalled();
      } finally { cosEvents.off('agent:completed', completion); }
    });

  it.each(['own-seed', 'inherited'])('settles a %s retirement receipt without inventing a captured head or successful result', async scenario => {
    const id = 'seeded-retired', startedAt = '2026-01-01T00:00:00Z', completedAt = '2026-01-01T00:01:00Z';
    const stages = Object.fromEntries(['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report'].map(key => [key, { status: 'done' }]));
    stages.worktree = { status: 'held', reason: 'checkout-capture-pending' };
    const record = { id, taskId: 'failed-investigation', status: 'completed', startedAt, completedAt,
      result: { success: false, executionSuccess: true, validationPassed: false, taskOutcome: { status: 'blocked' } },
      metadata: { completedCheckouts: [], checkoutCapture: { status: 'pending', unknown: true, targets: [] },
        completionCleanup: { version: 1, status: 'pending', stages, replay: { version: 1 } } } };
    mockCosState.state.agents[id] = record;
    const directory = join(mockCosState.agentsDir, completedAt.slice(0, 10), id);
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'metadata.json'), JSON.stringify(record));
    const proof = { retiredHead: 'a'.repeat(40), checkoutIdentity: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
    const inherited = scenario === 'inherited';
    if (inherited) {
      record.metadata.isWorktree = false; record.metadata.resumedFromAgentId = 'original-parent';
      proof.inheritedFromAgentId = 'original-parent';
    }
    const write = inherited ? recordInheritedCheckoutRetirement : recordSeededCheckoutRetirement;
    expect(await write(id, { ...record, metadata: { ...record.metadata, changed: true } }, proof)).toBe(false);
    expect(await write(id, structuredClone(record), proof)).toBe(true);
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(saved.metadata.checkoutCapture).toMatchObject({ status: 'retired', unknown: true, reason: inherited ? 'inherited-scope-already-retired' : 'retired-by-service-receipt', ...proof });
    expect(saved.metadata.completedCheckouts).toEqual([]);
    expect(saved.metadata.completionCleanup).toMatchObject({ status: 'completed', stages: { worktree: { status: 'done', verifiedBy: inherited ? 'inherited-service-retirement-receipt' : 'service-retirement-receipt' } } });
    expect(saved.metadata.completionCleanup).not.toHaveProperty('replay');
    expect(saved.metadata.repoStateVerification).toMatchObject({ status: 'completed', physicalRetirementVerified: true });
    expect(saved.result).toEqual(record.result);
    await recordRepoStateVerification(id, { status: 'pending', checkedAt: '2026-01-01T00:03:00Z', reasons: ['task-unavailable'] });
    const replayed = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(replayed.metadata.repoStateVerification).toMatchObject({ status: 'completed', reasons: [], physicalRetirementVerified: true });
    expect(replayed.result).toEqual(record.result);
    expect(await write(id, record, proof)).toBe(false);
  });

  it('settles only the unchanged predecessor cleanup ledger, preserving unknown capture and failed execution', async () => {
    const id = 'seeded-predecessor', startedAt = '2026-01-01T00:00:00Z', completedAt = '2026-01-01T00:01:00Z';
    const stages = Object.fromEntries(['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report'].map(key => [key, { status: 'done' }]));
    stages.worktree = { status: 'held', reason: 'checkout-capture-pending' };
    const record = { id, taskId: 'same-task', status: 'completed', startedAt, completedAt,
      result: { success: false, executionSuccess: true }, metadata: { completedCheckouts: [],
        checkoutCapture: { status: 'pending', unknown: true, targets: [] },
        completionCleanup: { version: 1, status: 'pending', stages, replay: { version: 1 } } } };
    mockCosState.state.agents[id] = record;
    const directory = join(mockCosState.agentsDir, completedAt.slice(0, 10), id);
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'metadata.json'), JSON.stringify(record));
    const proof = { successorAgentId: 'delivered-successor', head: 'a'.repeat(40), checkoutIdentity: 'b'.repeat(64) };
    expect(await recordSuccessorCheckoutRetirement(id, { ...record, metadata: { ...record.metadata, changed: true } }, proof)).toBe(false);
    expect(await recordSuccessorCheckoutRetirement(id, structuredClone(record), proof)).toBe(true);
    const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    expect(saved.metadata.checkoutCapture).toMatchObject({ status: 'retired', unknown: true, successorAgentId: proof.successorAgentId });
    expect(saved.metadata.completedCheckouts).toEqual([]);
    expect(saved.metadata.completionCleanup.status).toBe('completed');
    expect(saved.metadata.completionCleanup).not.toHaveProperty('replay');
    expect(saved.result).toEqual(record.result);
    expect(await recordSuccessorCheckoutRetirement(id, record, proof)).toBe(false);
  });

  it('drops replay inputs from durable terminal ledgers without erasing independent preservation holds', async () => {
    const id = 'claim-terminal-ledger';
    const startedAt = '2026-01-01T00:00:00Z';
    mockCosState.state.agents[id] = { id, status: 'running', startedAt, output: [], metadata: {
      claimPicksOwnBranch: true, completionCleanup: { version: 1, status: 'pending',
        context: { task: { id: 'original' }, outputBuffer: 'large legacy output' },
        replay: { version: 1, kind: 'replay', bytes: 123, sha256: 'a'.repeat(64) }, stages: {} } } };
    const completed = await completeAgent(id, { success: true });
    expect(await recordCompletionCleanup(id, startedAt, { status: 'failed', stages: {
      pipeline: { status: 'failed', retryable: false, reason: 'external-state-unknown' } } })).toBe(true);
    const archived = JSON.parse(await readFile(join(mockCosState.agentsDir, completed.completedAt.slice(0, 10), id, 'metadata.json'), 'utf8'));
    expect(archived.metadata.completionCleanup.status).toBe('failed');
    expect(archived.metadata.completionCleanup).not.toHaveProperty('context');
    expect(archived.metadata.completionCleanup).not.toHaveProperty('replay');
    expect(archived.metadata.repoStateVerification.status).toBe('pending');
  });

  it('records transient capture failure as a durable unknown obligation without rerunning finalization', async () => {
    const agentId = 'claim-capture-failed';
    mockCosState.state.agents[agentId] = { id: agentId, status: 'running', metadata: { claimPicksOwnBranch: true }, output: [] };
    captureCompletedCheckouts.mockRejectedValueOnce(new Error('checkout unreadable'));
    const result = await completeAgent(agentId, { success: true });
    expect(result).toMatchObject({ status: 'completed', result: { success: false, executionSuccess: true, cleanupPending: true },
      metadata: { claimPicksOwnBranch: true, completedCheckouts: [], checkoutCapture: { status: 'pending', unknown: true } } });
    await completeAgent(agentId, { success: false, exitCode: 143 });
    expect(mockCosState.state.agents[agentId].result.executionSuccess).toBe(true);
    mockCosState.state.agents['claim-failed'] = { id: 'claim-failed', status: 'running',
      metadata: { claimPicksOwnBranch: true, completedCheckouts: [{ stale: true }] }, output: [] };
    const failed = await completeAgent('claim-failed', { success: false });
    expect(failed.metadata.completedCheckouts).toEqual([]);
    expect(captureCompletedCheckouts).toHaveBeenCalledTimes(2);
  });

  it('archives owned checkout identity on execution failure without claiming delivery success', async () => {
    const id = 'failed-owned-checkout';
    const evidence = { version: 1, agentId: id, branch: 'feature/failed-owned' };
    mockCosState.state.agents[id] = { id, status: 'running', startedAt: '2026-01-01T00:00:00Z', output: [],
      metadata: { isWorktree: true, worktreeBranch: evidence.branch } };
    captureCompletedCheckouts.mockImplementationOnce(async agent => {
      expect(agent.status).toBe('running');
      return [evidence];
    });
    const failed = await completeAgent(id, { success: false, executionSuccess: false, orphaned: true });
    expect(failed.result).toMatchObject({ success: false, executionSuccess: false, orphaned: true });
    expect(failed.result.cleanupPending).not.toBe(true);
    expect(failed.metadata).toMatchObject({ completedCheckouts: [evidence], checkoutCapture: { status: 'captured' } });
    const persisted = JSON.parse(await readFile(join(mockCosState.agentsDir, failed.completedAt.slice(0, 10), id, 'metadata.json'), 'utf8'));
    expect(persisted.result).toEqual(failed.result);
    expect(persisted.metadata.completedCheckouts).toEqual([evidence]);
  });

  for (const inline of [false, true, 'claim', 'review']) seedBodies.it(`recovers an unknown terminal capture through verified merge proof, inline=${inline}`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'portos-reviewed-capture-'));
    try {
      const repo = join(scratch, 'repo'), checkout = join(scratch, 'checkout');
      await materializeGitRepo(repo);
      await execGit(['worktree', 'add', '-b', 'feature/reviewed', checkout, 'main'], repo);
      const actual = await vi.importActual('./completedCheckoutEvidence.js');
      captureCheckoutSeeds.mockImplementationOnce(actual.captureCheckoutSeeds);
      captureCompletedCheckouts.mockImplementationOnce(actual.captureCompletedCheckouts);
      const agentId = 'reviewed-unknown', prUrl = 'https://github.com/example/repo/pull/7';
      await registerAgent(agentId, 'reviewed-task', { isWorktree: true, sourceWorkspace: repo,
        workspacePath: checkout, worktreeBranch: 'feature/reviewed',
        ...(inline === 'claim' ? { isWorktree: false, configClaimFlow: true, claimBranches: ['feature/reviewed'], workspacePath: repo }
          : inline === 'review' ? { prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { url: prUrl, branch: 'feature/reviewed' } }
          : inline ? { prOpenedBy: 'agent-inline', configOpenPR: true,
          prDeliveryTarget: { branch: 'feature/reviewed', workspacePath: checkout } }
          : { reviewLoopMergeTarget: { url: prUrl, branch: 'feature/reviewed' } }) });
      if (inline === 'claim') {
        const bound = await getAgent(agentId);
        await updateAgent(agentId, { metadata: { ...bound.metadata, checkoutSeeds: await actual.captureCheckoutSeeds(bound) } });
      }
      const merged = vi.spyOn(await import('./completedCheckoutEvidence.js'), 'readMergedClaimEvidence').mockResolvedValue(null);
      const head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
      const unavailable = vi.spyOn(await import('./worktreeManager.js'), 'listWorktrees')
        .mockRejectedValueOnce(new Error('completion inventory unavailable'))
        .mockRejectedValueOnce(new Error('preterminal fallback unavailable'));
      const completed = await completeAgent(agentId, { success: true });
      unavailable.mockRestore();
      expect(completed.metadata.checkoutCapture).toMatchObject({ status: 'pending', unknown: true, targets: [] });
      const originalResult = structuredClone(completed.result);
      delete mockCosState.state.agents[agentId];
      expect(await retryCompletionCheckoutCapture(agentId)).toBe(false); // No guessed historical head.
      const retirement = { repoPath: repo, branch: 'feature/reviewed', path: checkout, head, prUrl, verifiedMergedHead: head };
      expect(await retryCompletionCheckoutCapture(agentId, { retirement: { ...retirement, prUrl: prUrl + '0' } })).toBe(false);
      expect(await retryCompletionCheckoutCapture(agentId, { retirement: { ...retirement, verifiedMergedHead: 'a'.repeat(40) } })).toBe(false);
      mockCosState.state.agents['later-owner'] = { id: 'later-owner', status: 'completed', startedAt: new Date().toISOString(),
        metadata: { sourceWorkspace: repo, workspacePath: checkout, worktreeBranch: retirement.branch } };
      expect(await retryCompletionCheckoutCapture(agentId, { retirement })).toBe(false);
      delete mockCosState.state.agents['later-owner'];
      if (inline) {
        if (inline === 'review') {
          merged.mockResolvedValue({ prUrl: `${prUrl}0`, mergedAt: new Date().toISOString() });
          expect(await retryCompletionCheckoutCapture(agentId)).toBe(false);
        }
        merged.mockResolvedValue({ prUrl, mergedAt: new Date().toISOString() });
        mockCosState.state.agents['later-owner'] = { id: 'later-owner', status: 'running', startedAt: new Date().toISOString(),
          metadata: { sourceWorkspace: repo, workspacePath: checkout, worktreeBranch: retirement.branch } };
        expect(await retryCompletionCheckoutCapture(agentId)).toBe(false);
        delete mockCosState.state.agents['later-owner'];
      }
      const captureEvents = vi.spyOn(cosEvents, 'emit');
      expect(await retryCompletionCheckoutCapture(agentId, inline ? {} : { retirement })).toBe(true);
      expect(captureEvents.mock.calls.filter(([event]) => event === 'agent:checkout-captured')).toEqual([['agent:checkout-captured', { agentId }]]);
      const saved = await getAgent(agentId);
      expect(saved.result).toEqual(originalResult);
      expect(saved.completedAt).toBe(completed.completedAt);
      expect(saved.metadata.completedCheckouts).toEqual([expect.objectContaining({ version: 2, head })]);
      expect(completedCheckoutReceiptValid(saved, saved.metadata.completedCheckouts[0])).toBe(true);
      expect(await retryCompletionCheckoutCapture(agentId, { retirement })).toBe(false);
      expect(captureEvents.mock.calls.filter(([event]) => event === 'agent:checkout-captured')).toHaveLength(1);
      captureEvents.mockRestore();
      merged.mockRestore();
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  // Each delivery arm must refuse when only its own branch or workspace binding
  // diverges from the seed, and recover again once the binding is restored.
  const deliveryArms = {
    inline: {
      metadata: ({ checkout }) => ({ prOpenedBy: 'agent-inline', configOpenPR: true,
        prDeliveryTarget: { branch: 'feature/arm', workspacePath: checkout } }),
      branch: metadata => ({ ...metadata, prDeliveryTarget: { ...metadata.prDeliveryTarget, branch: 'feature/other' } }),
      workspace: (metadata, { other }) => ({ ...metadata, prDeliveryTarget: { ...metadata.prDeliveryTarget, workspacePath: other } }),
    },
    claim: {
      metadata: ({ repo }) => ({ isWorktree: false, configClaimFlow: true, claimBranches: ['feature/arm'], workspacePath: repo }),
      branch: metadata => ({ ...metadata, claimBranches: ['feature/other'] }),
      workspace: (metadata, { other }) => ({ ...metadata, sourceWorkspace: other }),
    },
    'review-then-merge': {
      metadata: ({ prUrl }) => ({ prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { url: prUrl, branch: 'feature/arm' } }),
      branch: metadata => ({ ...metadata, reviewLoopMergeTarget: { ...metadata.reviewLoopMergeTarget, branch: 'feature/other' } }),
      workspace: (metadata, { other }) => ({ ...metadata, workspacePath: other }),
    },
  };
  const armCases = Object.keys(deliveryArms).flatMap(arm => ['branch', 'workspace'].map(divergence => [arm, divergence]));

  /** Complete an agent whose terminal capture is unknown, then drop it from live state so only the archive remains. */
  async function archivedUnknownCapture({ scratch, arm, extraMetadata = {} }) {
    const repo = join(scratch, 'repo'), checkout = join(scratch, 'checkout'), other = join(scratch, 'other');
    await mkdir(other, { recursive: true });
    await materializeGitRepo(repo);
    await execGit(['worktree', 'add', '-b', 'feature/arm', checkout, 'main'], repo);
    const actual = await vi.importActual('./completedCheckoutEvidence.js');
    captureCheckoutSeeds.mockImplementationOnce(actual.captureCheckoutSeeds);
    captureCompletedCheckouts.mockImplementationOnce(actual.captureCompletedCheckouts);
    const agentId = 'arm-unknown', prUrl = 'https://github.com/example/repo/pull/9';
    const context = { repo, checkout, other, prUrl };
    await registerAgent(agentId, 'arm-task', { isWorktree: true, sourceWorkspace: repo, workspacePath: checkout,
      worktreeBranch: 'feature/arm', ...deliveryArms[arm].metadata(context), ...extraMetadata });
    if (arm === 'claim') {
      const bound = await getAgent(agentId);
      await updateAgent(agentId, { metadata: { ...bound.metadata, checkoutSeeds: await actual.captureCheckoutSeeds(bound) } });
    }
    const head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    const unavailable = vi.spyOn(await import('./worktreeManager.js'), 'listWorktrees')
      .mockRejectedValueOnce(new Error('completion inventory unavailable'))
      .mockRejectedValueOnce(new Error('preterminal fallback unavailable'));
    const completed = await completeAgent(agentId, { success: true });
    unavailable.mockRestore();
    expect(completed.metadata.checkoutCapture).toMatchObject({ status: 'pending', unknown: true, targets: [] });
    const archive = join(mockCosState.agentsDir, completed.completedAt.slice(0, 10), agentId, 'metadata.json');
    const original = JSON.parse(await readFile(archive, 'utf8'));
    delete mockCosState.state.agents[agentId];
    return { agentId, repo, checkout, other, prUrl, head, original,
      patchMetadata: async metadata => writeFile(archive, JSON.stringify({ ...original, metadata })) };
  }

  for (const [arm, divergence] of armCases) seedBodies.it(`refuses unknown-capture recovery when only the ${arm} arm's ${divergence} binding diverges`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'portos-delivery-arm-'));
    const merged = vi.spyOn(await import('./completedCheckoutEvidence.js'), 'readMergedClaimEvidence').mockResolvedValue(null);
    try {
      const { agentId, other, prUrl, original, patchMetadata } = await archivedUnknownCapture({ scratch, arm });
      merged.mockResolvedValue({ prUrl, mergedAt: new Date().toISOString() });
      await patchMetadata(deliveryArms[arm][divergence](original.metadata, { other }));
      expect(await retryCompletionCheckoutCapture(agentId)).toBe(false);
      expect((await getAgent(agentId)).metadata.checkoutCapture).toMatchObject({ status: 'pending', unknown: true });
      await patchMetadata(original.metadata);
      expect(await retryCompletionCheckoutCapture(agentId)).toBe(true);
      expect((await getAgent(agentId)).metadata.checkoutCapture.status).toBe('captured');
    } finally {
      merged.mockRestore();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  for (const [label, historical, expected] of [
    ['a later-generation', { startedAt: '2999-01-01T00:00:00Z' }, false],
    ['an unparseable-generation', { startedAt: 'not-a-date' }, false],
    ['an earlier-generation', { startedAt: '2000-01-01T00:00:00Z' }, true],
  ]) seedBodies.it(`${expected ? 'recovers despite' : 'refuses'} ${label} historical agent that released the same branch`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'portos-delivery-arm-'));
    const merged = vi.spyOn(await import('./completedCheckoutEvidence.js'), 'readMergedClaimEvidence').mockResolvedValue(null);
    try {
      const { agentId, repo, prUrl } = await archivedUnknownCapture({ scratch, arm: 'review-then-merge' });
      merged.mockResolvedValue({ prUrl, mergedAt: new Date().toISOString() });
      mockCosState.state.agents['released-owner'] = { id: 'released-owner', status: 'completed', ...historical,
        metadata: { sourceWorkspace: repo, claimReleasedBranches: ['feature/arm'] } };
      expect(await retryCompletionCheckoutCapture(agentId)).toBe(expected);
    } finally {
      merged.mockRestore();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  for (const scenario of ['unchanged', 'physical-generation', 'new-owner', 'later-head', 'orphan-empty', 'orphan-physical-generation', 'orphan-new-owner', 'orphan-later-head']) {
    seedBodies.it(`recovers only the original completion physical seed after restart, scenario=${scenario}`, async () => {
      const orphan = scenario.startsWith('orphan-');
      const changed = !['unchanged', 'orphan-empty'].includes(scenario);
      const scratch = await mkdtemp(join(tmpdir(), 'portos-completion-capture-seed-'));
      let failFirstRead;
      try {
        const repo = join(scratch, 'repo');
        const checkout = join(scratch, 'checkout');
        await materializeGitRepo(repo);
        await execGit(['worktree', 'add', '-b', 'feature/seeded', checkout, 'main'], repo);
        const actual = await vi.importActual('./completedCheckoutEvidence.js');
        captureCheckoutSeeds.mockImplementationOnce(actual.captureCheckoutSeeds);
        captureCompletedCheckouts.mockImplementationOnce(actual.captureCompletedCheckouts);
        const agentId = `seeded-${changed}`;
        await registerAgent(agentId, 'seeded-task', { isWorktree: true, sourceWorkspace: repo,
          workspacePath: checkout, worktreeBranch: 'feature/seeded' });
        const seed = mockCosState.state.agents[agentId].metadata.checkoutSeeds[0];
        expect(seed).toMatchObject({ agentId, branch: 'feature/seeded' });
        await writeFile(join(checkout, 'delivery.txt'), 'wanted original work');
        await execGit(['add', 'delivery.txt'], checkout);
        await execGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'final delivered head'], checkout);
        const head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
        if (orphan) captureCompletedCheckouts.mockReset().mockResolvedValueOnce([]); // Historical failed-run empty capture.
        else failFirstRead = vi.spyOn(await import('./worktreeManager.js'), 'listWorktrees').mockRejectedValueOnce(new Error('first completion Git read unavailable'));
        const completed = await completeAgent(agentId, orphan ? { success: false, executionSuccess: false, orphaned: true } : { success: true });
        if (orphan) expect(completed).toMatchObject({ result: { success: false, executionSuccess: false, orphaned: true },
          metadata: { completedCheckouts: [], checkoutCapture: { status: 'captured' } } });
        else expect(completed).toMatchObject({ status: 'completed', result: { cleanupPending: true, executionSuccess: true },
          metadata: { checkoutCapture: { status: 'pending', unknown: false, targets: [expect.objectContaining({ head })] } } });
        expect(cosEvents.listenerCount('agent:completed')).toBeGreaterThan(0);
        delete mockCosState.state.agents[agentId]; // Restart: only the real archived metadata remains.
        let retainedHead = head;
        if (scenario.endsWith('later-head')) {
          await execGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'later unrelated writer'], checkout);
          retainedHead = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
        }
        if (scenario.endsWith('new-owner')) {
          mockCosState.state.agents['new-owner'] = { id: 'new-owner', status: 'completed', startedAt: new Date().toISOString(),
            metadata: { sourceWorkspace: repo, workspacePath: checkout, worktreeBranch: 'feature/seeded' } };
        }
        if (scenario.endsWith('physical-generation')) {
          const pointer = join(checkout, '.git');
          const bytes = await readFile(pointer);
          await rename(pointer, join(scratch, 'original-git-pointer'));
          await writeFile(pointer, bytes);
        }
        const options = orphan ? { retirement: { repoPath: repo, branch: 'feature/seeded', path: checkout, head } } : {};
        expect(await retryCompletionCheckoutCapture(agentId, options)).toBe(!changed);
        const recovered = await getAgent(agentId);
        if (changed) expect(recovered.metadata.checkoutCapture.status).toBe(orphan ? 'captured' : 'pending');
        else {
          const receipt = recovered.metadata.completedCheckouts[0];
          expect(receipt).toMatchObject({ version: 2, head, seededAt: seed.seededAt });
          expect(Date.parse(receipt.capturedAt)).toBeGreaterThanOrEqual(Date.parse(completed.completedAt));
          expect(completedCheckoutReceiptValid(recovered, receipt)).toBe(true);
        }
        if (orphan) expect(recovered.result).toEqual(completed.result);
        expect(await readFile(join(checkout, 'delivery.txt'), 'utf8')).toBe('wanted original work');
        expect((await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim()).toBe(retainedHead);
        expect(emittedCompletions).toHaveLength(1);
      } finally {
        failFirstRead?.mockRestore();
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  }

  it('keeps the first verdict when a duplicate completion arrives', async () => {
    // Regression: a stray runner `agent:completed` for an agent that had already
    // finalized on its own sentinel replaced a recorded success with
    // `success: false, exitCode: 143`, flipping the card to Failed and requeueing
    // a finished task.
    const agentId = 'agent-duplicate-completion';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const first = await completeAgent(agentId, { success: true, exitCode: 0, duration: 1000 });
    expect(first.result.success).toBe(true);

    saveState.mockClear();
    recordDomainUsage.mockClear();
    emittedCompletions.length = 0;

    const second = await completeAgent(agentId, {
      success: false,
      exitCode: 143,
      errorAnalysis: { category: 'startup-failure' }
    });

    expect(second.result).toEqual(first.result);
    expect(second.result.success).toBe(true);
    expect(second.result.errorAnalysis).toBeUndefined();
    expect(second.completedAt).toBe(first.completedAt);
    expect(mockCosState.state.agents[agentId].result.success).toBe(true);

    // A no-op all the way out: no state write, no double budget charge, and no
    // second `agent:completed` (whose handler schedules the next task).
    expect(saveState).not.toHaveBeenCalled();
    expect(recordDomainUsage).not.toHaveBeenCalled();
    expect(emittedCompletions).toEqual([]);
    expect(mockCosState.state.stats).toEqual({ tasksCompleted: 1, errors: 0 });
  });

  it('does not re-run the completed-agent directory move on a duplicate', async () => {
    const agentId = 'agent-duplicate-archive';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const first = await completeAgent(agentId, { success: true, exitCode: 0 });
    const archivedMetadata = join(
      mockCosState.agentsDir, first.completedAt.slice(0, 10), agentId, 'metadata.json'
    );
    expect(existsSync(archivedMetadata)).toBe(true);

    // Late output can land back in the flat dir after the archive move. A second
    // completion must leave it alone rather than sweeping it into the bucket.
    const flatDir = join(mockCosState.agentsDir, agentId);
    await mkdir(flatDir, { recursive: true });
    await writeFile(join(flatDir, 'output.txt'), 'post-archive line\n');

    await completeAgent(agentId, { success: false, exitCode: 143 });

    expect(existsSync(join(flatDir, 'output.txt'))).toBe(true);
    const archived = JSON.parse(await readFile(archivedMetadata, 'utf8'));
    expect(archived.result.success).toBe(true);
    expect(archived.result.exitCode).toBe(0);
  });

  it('finishes a half-done archive using the already-recorded verdict', async () => {
    // A prior completion that threw between its state write and the directory
    // move leaves the record `completed` but never archived. The duplicate call
    // repairs the archive — with the FIRST verdict, not the caller's.
    const agentId = 'agent-half-archived';
    const completedAt = '2026-05-25T12:00:00.000Z';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'completed',
      completedAt,
      result: { validationPassed: null, success: true, exitCode: 0 },
      metadata: { taskType: 'scheduled' },
      output: []
    };
    const flatDir = join(mockCosState.agentsDir, agentId);
    await mkdir(flatDir, { recursive: true });
    await writeFile(join(flatDir, 'output.txt'), 'the run that finished\n');

    const returned = await completeAgent(agentId, { success: false, exitCode: 143 });

    const archiveDir = join(mockCosState.agentsDir, '2026-05-25', agentId);
    const archived = JSON.parse(await readFile(join(archiveDir, 'metadata.json'), 'utf8'));
    expect(archived.result.success).toBe(true);
    expect(archived.result.exitCode).toBe(0);
    expect(existsSync(join(archiveDir, 'output.txt'))).toBe(true);
    expect(existsSync(flatDir)).toBe(false);

    // Repairing the archive is NOT a re-completion: verdict, ledger and the
    // scheduler hand-off all stay untouched.
    expect(returned.result.success).toBe(true);
    expect(recordDomainUsage).not.toHaveBeenCalled();
    expect(emittedCompletions).toEqual([]);
    expect(mockCosState.state.stats).toEqual({ tasksCompleted: 0, errors: 0 });
  });

  it('rolls back a half-copied archive so the next completion can repair it', async () => {
    // `existsSync(targetDir)` is what every later archive attempt reads as
    // "already archived" — so a cross-filesystem copy that dies partway must not
    // leave the destination behind, or the rest of the run's files are stranded.
    const agentId = 'agent-partial-copy';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };
    const flatDir = join(mockCosState.agentsDir, agentId);
    await mkdir(flatDir, { recursive: true });
    await writeFile(join(flatDir, 'output.txt'), 'the run that finished\n');

    // The move into the bucket fails as if cross-filesystem, then the copy
    // fallback dies partway through writing the files it created the dir for.
    fsFailures.dateBucketWritesFail = true;

    await expect(completeAgent(agentId, { success: true, exitCode: 0 }))
      .rejects.toThrow('simulated copy failure');

    const archiveDir = join(
      mockCosState.agentsDir,
      mockCosState.state.agents[agentId].completedAt.slice(0, 10),
      agentId
    );
    expect(existsSync(archiveDir)).toBe(false);

    // A completion sweep between failure and retry must not create a bucket
    // that makes archiveCompletedAgent skip the original transcript move.
    await recordRepoStateVerification(agentId, { status: 'pending', reasons: ['retry'] });
    expect(existsSync(archiveDir)).toBe(false);
    expect(await readFile(join(flatDir, 'output.txt'), 'utf8')).toBe('the run that finished\n');

    fsFailures.dateBucketWritesFail = false;
    recordDomainUsage.mockClear();
    emittedCompletions.length = 0;

    // The retry is a duplicate completion (the verdict was persisted before the
    // copy blew up), so it repairs the archive with the FIRST verdict.
    await completeAgent(agentId, { success: false, exitCode: 143 });

    const archived = JSON.parse(await readFile(join(archiveDir, 'metadata.json'), 'utf8'));
    expect(archived.result.success).toBe(true);
    expect(existsSync(join(archiveDir, 'output.txt'))).toBe(true);
    expect(existsSync(flatDir)).toBe(false);
    expect(recordDomainUsage).not.toHaveBeenCalled();
    expect(emittedCompletions).toEqual([]);
  });

  it('re-persists a missing index entry for an already-archived agent', async () => {
    // `saveAgentIndex` swallows its own write errors, so a failed write leaves
    // the in-memory map right and index.json wrong — the archive would be
    // unreachable from history after a restart. A duplicate completion repairs
    // the index even though the directory move itself is already done.
    const agentId = 'agent-unindexed';
    const completedAt = '2026-05-25T12:00:00.000Z';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'completed',
      completedAt,
      result: { validationPassed: null, success: true, exitCode: 0 },
      metadata: { taskType: 'scheduled' },
      output: []
    };
    const archiveDir = join(mockCosState.agentsDir, '2026-05-25', agentId);
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, 'metadata.json'), JSON.stringify({ id: agentId, result: { success: true } }));

    await completeAgent(agentId, { success: false, exitCode: 143 });

    const index = JSON.parse(await readFile(join(mockCosState.agentsDir, 'index.json'), 'utf8'));
    expect(index[agentId]).toBe('2026-05-25');
    // Repairing the index must not rewrite the archived verdict.
    const archived = JSON.parse(await readFile(join(archiveDir, 'metadata.json'), 'utf8'));
    expect(archived.result.success).toBe(true);
    expect(existsSync(join(mockCosState.agentsDir, agentId))).toBe(false);
  });

  it('completes a still-paused agent (the guard is completed-only, not running-only)', async () => {
    const agentId = 'agent-paused-completion';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'paused',
      pausedAt: '2026-05-25T12:00:00.000Z',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const done = await completeAgent(agentId, { success: true, exitCode: 0 });

    expect(done.status).toBe('completed');
    expect(done.result.success).toBe(true);
  });

  it('completes a paused agent that resumed back to running', async () => {
    const agentId = 'agent-resumed-completion';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const paused = await updateAgent(agentId, { status: 'paused', pausedAt: '2026-05-25T12:00:00.000Z' });
    expect(paused.status).toBe('paused');

    const resumed = await updateAgent(agentId, { status: 'running' });
    expect(resumed.status).toBe('running');

    const done = await completeAgent(agentId, { success: true, exitCode: 0 });

    expect(done.status).toBe('completed');
    expect(done.result.success).toBe(true);
    expect(emittedCompletions).toHaveLength(1);
  });

  it('re-registering an id resets it to running so a retry can complete again', async () => {
    // Spawns mint a fresh `agent-<uuid>` id, so this only matters if one ever
    // collides — registerAgent must still hand back a completable record.
    const agentId = 'agent-reregistered';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };
    await completeAgent(agentId, { success: false, exitCode: 1 });

    const reregistered = await registerAgent(agentId, 'task-retry', { taskType: 'scheduled' });
    expect(reregistered.status).toBe('running');

    const done = await completeAgent(agentId, { success: true, exitCode: 0 });
    expect(done.result.success).toBe(true);
  });
});

describe('createAgentOutputBatcher', () => {
  const agentId = 'agent-batch';

  beforeEach(() => {
    saveState.mockClear();
    mockCosState.state = { agents: { [agentId]: { id: agentId, output: [] } } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesces many pushed lines into a single state write on flush', async () => {
    const batcher = createAgentOutputBatcher(agentId);
    batcher.push('line 1');
    batcher.push('line 2');
    batcher.push(['line 3', 'line 4']); // array push appends each line
    await batcher.flush();

    // Write-amplification guard: 4 lines, one load+save — not one per line.
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(mockCosState.state.agents[agentId].output.map((o) => o.line)).toEqual([
      'line 1', 'line 2', 'line 3', 'line 4'
    ]);
  });

  it('flush() is a no-op (no state write) when nothing was pushed', async () => {
    const batcher = createAgentOutputBatcher(agentId);
    await batcher.flush();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('captures lines pushed during an in-flight drain', async () => {
    const batcher = createAgentOutputBatcher(agentId);
    batcher.push('first');
    const flushing = batcher.flush();
    batcher.push('raced-in'); // arrives while the first drain is awaiting
    await flushing;
    await batcher.flush(); // second flush picks up the raced-in line

    expect(mockCosState.state.agents[agentId].output.map((o) => o.line)).toEqual([
      'first', 'raced-in'
    ]);
  });

  it('swallows + logs a state-write failure so flush() never rejects', async () => {
    saveState.mockRejectedValueOnce(new Error('disk full'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const batcher = createAgentOutputBatcher(agentId);
    batcher.push('doomed line');

    await expect(batcher.flush()).resolves.toBeUndefined();
    const logged = consoleSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' &&
        args[0].startsWith(`❌ agent ${agentId} output batch flush failed:`)
    );
    expect(logged).toBe(true);
  });
});

describe('cleanupZombieAgents — runner listing is not proof of life', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {} };
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([]);
    activeAgents.clear();
    runnerAgents.clear();
    spawningTasks.clear();
  });

  afterEach(async () => {
    spawningTasks.clear();
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('leaves an exited runner to its in-flight completion, then reaps if completion failed', async () => {
    await writeFile(join(mockCosState.agentsDir, 'index.json'), '{}');
    mockCosState.state.agents['agent-finishing'] = {
      id: 'agent-finishing', status: 'running', pid: 2147483646,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    completingAgents.add('agent-finishing');
    try {
      expect((await cleanupZombieAgents()).cleaned).toEqual([]);
      expect(mockCosState.state.agents['agent-finishing'].status).toBe('running');
    } finally {
      completingAgents.delete('agent-finishing');
    }
    expect((await cleanupZombieAgents()).cleaned).toEqual(['agent-finishing']);
  });

  it('does not reap a pid-less record while its task is still being dispatched', async () => {
    await writeFile(join(mockCosState.agentsDir, 'index.json'), '{}');
    mockCosState.state.agents['agent-slow'] = {
      id: 'agent-slow',
      taskId: 'task-slow',
      status: 'running',
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    spawningTasks.add('task-slow');

    expect((await cleanupZombieAgents()).cleaned).toEqual([]);
    expect(mockCosState.state.agents['agent-slow'].status).toBe('running');

    // Once the dispatch gives up the task without ever recording a pid, the
    // record really is a never-started zombie again.
    spawningTasks.delete('task-slow');
    expect((await cleanupZombieAgents()).cleaned).toEqual(['agent-slow']);
    expect(mockCosState.state.agents['agent-slow'].result.error).toMatch(/never started/);
  });

  it('does not reap a runner-owned TUI while the runner probe is unavailable', async () => {
    mockCosState.state.agents['agent-tui'] = {
      id: 'agent-tui',
      status: 'running',
      pid: 0,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      metadata: { useRunner: true, executionMode: 'runner-tui' },
    };
    vi.mocked(getActiveAgentsFromRunner).mockRejectedValueOnce(new Error('runner is booting'));

    const result = await cleanupZombieAgents();
    expect(result.cleaned).toEqual([]);
    expect(mockCosState.state.agents['agent-tui'].status).toBe('running');
  });

  it('leaves a live runner-owned TUI whose onExit liveness is true', async () => {
    mockCosState.state.agents['agent-tui'] = {
      id: 'agent-tui',
      status: 'running',
      pid: 0,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-tui',
      pid: 0,
      kind: 'tui',
      processActive: true,
      liveness: 'pty',
    }]);

    const result = await cleanupZombieAgents();
    expect(result.cleaned).toEqual([]);
    expect(mockCosState.state.agents['agent-tui'].status).toBe('running');
  });

  it('retires a stale listing even if runnerAgents already adopted the id', async () => {
    await writeFile(join(mockCosState.agentsDir, 'index.json'), '{}');
    runnerAgents.set('agent-stale', { taskId: 'task-1' });
    mockCosState.state.agents['agent-stale'] = {
      id: 'agent-stale',
      status: 'running',
      pid: 2147483646,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-stale',
      pid: 2147483646,
      kind: 'cli',
      processActive: false,
      liveness: 'pid',
    }]);

    const result = await cleanupZombieAgents();
    expect(result.cleaned).toEqual(['agent-stale']);
    expect(mockCosState.state.agents['agent-stale'].status).toBe('completed');
  });

  it('retires a durable running record whose runner listing is stale', async () => {
    await writeFile(join(mockCosState.agentsDir, 'index.json'), '{}');
    mockCosState.state.agents['agent-stale'] = {
      id: 'agent-stale',
      status: 'running',
      pid: 2147483646,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-stale',
      pid: 2147483646,
      kind: 'cli',
      processActive: false,
      liveness: 'pid',
    }]);

    const result = await cleanupZombieAgents();
    expect(result.cleaned).toEqual(['agent-stale']);
    expect(mockCosState.state.agents['agent-stale'].status).toBe('completed');
    expect(mockCosState.state.agents['agent-stale'].result.error).toMatch(/terminated unexpectedly/);
  });

  describe('agent:completed emission (#11766)', () => {
    const completedEvents = [];
    const onCompleted = (agent) => completedEvents.push(agent);

    beforeEach(() => {
      completedEvents.length = 0;
      cosEvents.on('agent:completed', onCompleted);
    });

    afterEach(() => {
      cosEvents.off('agent:completed', onCompleted);
    });

    it('emits exactly one agent:completed for a reaped zombie, and none on a second sweep', async () => {
      await writeFile(join(mockCosState.agentsDir, 'index.json'), '{}');
      mockCosState.state.agents['agent-dead'] = {
        id: 'agent-dead',
        taskId: 'task-dead',
        status: 'running',
        pid: 2147483646,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        metadata: { taskType: 'scheduled' },
      };
      // Listeners that re-read state must already see the finalized record.
      let statusSeenByListener;
      cosEvents.once('agent:completed', () => {
        statusSeenByListener = mockCosState.state.agents['agent-dead'].status;
      });

      expect((await cleanupZombieAgents()).cleaned).toEqual(['agent-dead']);

      expect(statusSeenByListener).toBe('completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        id: 'agent-dead',
        taskId: 'task-dead',
        metadata: { taskType: 'scheduled' },
        result: { success: false },
      });

      expect((await cleanupZombieAgents()).cleaned).toEqual([]);
      expect(completedEvents).toHaveLength(1);
    });

    it('emits nothing for live, dispatching or runner-shielded records', async () => {
      mockCosState.state.agents['agent-owned'] = {
        id: 'agent-owned', status: 'running', pid: 2147483646,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      activeAgents.set('agent-owned', {});
      mockCosState.state.agents['agent-spawning'] = {
        id: 'agent-spawning', taskId: 'task-spawning', status: 'running',
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      };
      spawningTasks.add('task-spawning');
      mockCosState.state.agents['agent-tui'] = {
        id: 'agent-tui', status: 'running', pid: 0,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
        id: 'agent-tui', pid: 0, kind: 'tui', processActive: true, liveness: 'pty',
      }]);

      expect((await cleanupZombieAgents()).cleaned).toEqual([]);
      expect(completedEvents).toEqual([]);
    });
  });
});

describe('deleteAgent directory cleanup (#11446)', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {} };
  });

  afterEach(async () => {
    fsFailures.rmFailsFor = null;
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('logs the agentId and error when removing the agent directory fails, and still drops the record', async () => {
    const agentId = 'agent-rm-busy';
    await mkdir(join(mockCosState.agentsDir, agentId), { recursive: true });
    mockCosState.state.agents[agentId] = { id: agentId };
    fsFailures.rmFailsFor = agentId;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await deleteAgent(agentId);
      expect(result).toEqual({ success: true, agentId });
      expect(mockCosState.state.agents[agentId]).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^❌ .*agent-rm-busy.*EBUSY/));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('agent maintenance reservations on terminal transitions (#12737)', () => {
  const reserved = (agentId) => maintenance.status().blockers.some(b => b.kind === 'agent' && b.resource === agentId);
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    await writeFile(join(mockCosState.agentsDir, 'index.json'), '{}');
    mockCosState.state = { agents: {} };
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([]);
    activeAgents.clear();
    runnerAgents.clear();
    spawningTasks.clear();
  });
  afterEach(async () => {
    for (const id of ['agent-zombie', 'agent-purged', 'agent-live']) await maintenance.finishResource('agent', id);
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('releases the reservation of a reaped zombie', async () => {
    maintenance.admit('agent', 'agent-zombie');
    mockCosState.state.agents['agent-zombie'] = {
      id: 'agent-zombie', status: 'running', pid: 2147483646,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    expect((await cleanupZombieAgents()).cleaned).toEqual(['agent-zombie']);
    expect(reserved('agent-zombie')).toBe(false);
  });

  it('releases the reservation of a purged completed agent but keeps a running one', async () => {
    maintenance.admit('agent', 'agent-purged');
    maintenance.admit('agent', 'agent-live');
    mockCosState.state.agents['agent-purged'] = { id: 'agent-purged', status: 'completed' };
    mockCosState.state.agents['agent-live'] = { id: 'agent-live', status: 'running' };
    await deleteAgent('agent-purged');
    await deleteAgent('agent-live');
    expect(reserved('agent-purged')).toBe(false);
    expect(reserved('agent-live')).toBe(true);
  });
});
