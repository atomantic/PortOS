/** No-inventory completion must retain one exact obligation through execution release and real preservation. */
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
const fixture = vi.hoisted(() => ({ root: null, app: null, forge: null, task: null, agents: {}, schedule: null, raceTaskEdit: false }));
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-completion-retirement-state-') }));
vi.mock('./cos.js', () => ({}));
vi.mock('./domainUsage.js', () => ({ recordDomainUsage: async () => {} }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./apps.js', () => ({ getAppById: async id => id === fixture.app?.id ? fixture.app : null }));
vi.mock('./branchReconcileRetirement.js', async original => ({ ...await original(), assertAutomaticRetirementAllowed: async () => {} }));
vi.mock('./branchReconcile.js', async original => ({ ...await original(), listRemoteHeads: async () => new Map() }));
vi.mock('./heldCheckoutReview.js', async original => ({ ...await original(), readRetirementForgeEvidence: async () => fixture.forge }));
vi.mock('./prProbe.js', async original => ({ ...await original(), probePrForBranch: async () => ({ readable: true,
  prState: fixture.forge ? 'MERGED' : 'OPEN', prUrl: 'https://github.com/example/repo/pull/42', prNumber: 42, cli: 'gh' }) }));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: () => [] }));
vi.mock('./cosTaskStore.js', () => ({
  getTaskById: async () => JSON.parse(await readFile(join(fixture.root, 'task.json'), 'utf8')),
  getAllTasks: async () => ({ user: { tasks: [fixture.task] }, cos: { tasks: [] } }),
  updateTask: async (_id, patch, _type, { expectedStatus, expectedMetadata } = {}) => {
    const current = JSON.parse(await readFile(join(fixture.root, 'task.json'), 'utf8'));
    if (fixture.raceTaskEdit && patch.metadata?.deliveryRecovery === 'cleanup') {
      fixture.raceTaskEdit = false; current.metadata.updatedAt = 'concurrent-human-edit';
      await writeFile(join(fixture.root, 'task.json'), JSON.stringify(current));
    }
    if ((expectedStatus && current.status !== expectedStatus)
      || Object.entries(expectedMetadata || {}).some(([key, value]) => current.metadata?.[key] !== value)) return { statusChanged: true, task: current };
    fixture.task = current;
    fixture.task = { ...fixture.task, ...patch, metadata: { ...fixture.task.metadata, ...patch.metadata } };
    await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task)); return fixture.task;
  }, addTask: async () => { throw new Error('unexpected cognitive recovery'); },
}));
vi.mock('./cosState.js', async () => ({
  AGENTS_DIR: join((await import('../lib/paths.js')).PATHS.cos, 'agents'),
  loadState: async () => ({ agents: fixture.agents, stats: {} }),
  saveState: async state => { fixture.agents = state.agents; await writeFile(join(fixture.root, 'agents-state.json'), JSON.stringify(state)); },
  withStateLock: work => work(), readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: fixture.agents }),
}));
vi.mock('./branchCompletionPolicy.js', async original => ({ ...await original(), readBranchCompletionPolicies: async () => Object.values(fixture.agents) }));
vi.mock('./taskScheduleStore.js', async original => ({ ...await original(), loadSchedule: async () => fixture.schedule,
  updateSchedule: async mutate => { const output = await mutate(fixture.schedule);
    await writeFile(join(fixture.root, 'schedule.json'), JSON.stringify(fixture.schedule)); return output.result; },
}));
const { verifyAgentRepoState, sweepRepoStateVerifications } = await import('./agentRepoStateVerification.js');
const { bindCompletionTaskDispatch, prepareCompletionTaskHandoff } = await import('./agentCompletionTaskHandoff.js');
const { completeAgent, getAgentRecord } = await import('./cosAgentLifecycle.js');
const { getBranchReconcileOutcome } = await import('./taskSchedule.js');
const { activeAgents } = await import('./agentState.js');
const { PATHS } = await import('../lib/paths.js');
const { cosEvents } = await import('./cosEvents.js');
afterAll(cleanupTempDataRoots);
let scratch;
afterEach(async () => { activeAgents.clear(); if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); });
describe('completion to archive retirement (real Git and persisted service state)', () => {
  it('rotates beyond ten persisted pending handoffs even when repository verification finished earlier', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'portos-completion-sweep-'));
    fixture.root = PATHS.data; await mkdir(fixture.root, { recursive: true });
    fixture.task = { id: 'sweep-task', taskType: 'user', status: 'completed', metadata: {} };
    await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task));
    fixture.agents = Object.fromEntries(Array.from({ length: 11 }, (_, index) => {
      const id = `sweep-agent-${index}`;
      return [id, { id, taskId: fixture.task.id, status: 'completed', startedAt: '2020-01-01T00:00:00.000Z',
        result: { success: false }, metadata: { repoStateVerification: { status: 'completed', checkedAt: '2020-01-01T00:00:01.000Z' },
          completionCleanup: { version: 1, status: 'pending', updatedAt: new Date(1600000000000 + index).toISOString(),
            stages: { pipeline: { status: 'failed', retryable: false, reason: 'external-state-unknown' } } } } }];
    }));
    const waiting = fixture.agents['sweep-agent-10'].metadata.completionCleanup.updatedAt;
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 10, pendingAtStart: 11 });
    fixture.agents = JSON.parse(await readFile(join(fixture.root, 'agents-state.json'), 'utf8')).agents;
    expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.updatedAt).toBe(waiting);
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 10, pendingAtStart: 11 });
    fixture.agents = JSON.parse(await readFile(join(fixture.root, 'agents-state.json'), 'utf8')).agents;
    expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.lastAttemptAt).toEqual(expect.any(String));
    expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.stages.pipeline).toMatchObject({ status: 'failed', retryable: false });
    expect(fixture.task.status).toBe('completed');
  });

  it.each(['unchanged', 'changed-dispatch', 'concurrent-task-edit', 'claim-reacquired'])('recovers the missing task handoff after restart with exact task CAS (%s)', async scenario => {
    const changed = scenario !== 'unchanged';
    fixture.raceTaskEdit = false;
    cosEvents.emit.mockClear();
    scratch = await mkdtemp(join(tmpdir(), 'portos-completion-retirement-'));
    fixture.root = PATHS.data; await mkdir(fixture.root, { recursive: true });
    await materializeGitRepo(join(scratch, 'repo'));
    const repo = await realpath(join(scratch, 'repo'));
    const path = join(repo, '.claude', 'worktrees', 'completion'); const branch = 'claim/issue-42';
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    await writeFile(join(path, 'feature.txt'), 'delivered original\n');
    await execGit(['add', 'feature.txt'], path); await execGit(['commit', '-m', 'deliver original'], path);
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const running = { id: `agent-completion-${scenario}`, taskId: `task-completion-${scenario}`, status: 'running', startedAt, output: [],
      metadata: { isWorktree: true, sourceWorkspace: repo, workspacePath: path, worktreeBranch: branch, prCompletionPolicy: 'review-then-merge' } };
    await execGit(['merge', '--ff-only', branch], repo);
    const defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    await writeFile(join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n');
    await writeFile(join(path, 'ignored.txt'), 'private preserved bytes\n');
    fixture.forge = { repository: 'github.com/example/repo', prUrl: 'https://github.com/example/repo/pull/42', prHead: head, changeBase: (await execGit(['rev-parse', `${head}^`], repo)).stdout.trim(), firstCommit: head,
      mergeCommit: defaultHead, defaultBranch: 'main', defaultHead, remoteHead: null, changedPaths: ['feature.txt'] };
    fixture.app = { id: 'app-completion', repoPath: repo }; fixture.schedule = { tasks: {}, executions: {} };
    fixture.task = { id: running.taskId, taskType: 'user', status: 'in_progress', metadata: { app: fixture.app.id, openPR: true,
      prCompletion: 'review-then-merge', claimedBy: 'fixture-instance', claimedAt: startedAt, totalSpawnCount: 1,
      lastSpawnedAt: startedAt, updatedAt: startedAt } };
    await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task));
    fixture.agents = { [running.id]: running };
    activeAgents.set(running.id, { task: fixture.task });
    expect(await bindCompletionTaskDispatch(running.id, fixture.task)).toBe(true);
    expect(await prepareCompletionTaskHandoff(await getAgentRecord(running.id), { hookDelivery: { selectedPaths: ['feature.txt'] } })).toBe(true);
    const agent = await completeAgent(running.id, { success: true, executionSuccess: true, requireCheckoutSettlement: true });
    expect(agent.result).toMatchObject({ success: false, cleanupPending: true, executionSuccess: true });
    expect(agent.metadata.completedCheckouts).toHaveLength(1);
    await completeAgent(running.id, { success: true, executionSuccess: true, requireCheckoutSettlement: true });
    expect(cosEvents.emit.mock.calls.filter(([event]) => event === 'agent:completed')).toHaveLength(1);
    // Crash after terminal agent durability, BEFORE the normal task update.
    expect(JSON.parse(await readFile(join(fixture.root, 'task.json'), 'utf8')).metadata.deliveryRecovery).toBeUndefined();
    fixture.agents = JSON.parse(await readFile(join(fixture.root, 'agents-state.json'), 'utf8')).agents;
    fixture.task = JSON.parse(await readFile(join(fixture.root, 'task.json'), 'utf8'));
    if (scenario === 'concurrent-task-edit') fixture.raceTaskEdit = true;
    if (scenario === 'claim-reacquired') {
      // prepareAgentSpawn reclaims before registration or a fresh spawn stamp.
      const { buildClaim } = await import('./cosTaskClaim.js');
      Object.assign(fixture.task.metadata, buildClaim('fixture-instance'));
      await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task));
    }
    if (scenario === 'changed-dispatch') {
      fixture.task.metadata.totalSpawnCount++;
      await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task));
    }
    const verify = () => verifyAgentRepoState({ agentId: agent.id, agentState: fixture.agents[agent.id], task: fixture.task, success: false, prExpected: true });
    expect(await getBranchReconcileOutcome(fixture.app.id)).toBeNull(); activeAgents.set(agent.id, { task: fixture.task });
    if (changed) {
      activeAgents.delete(agent.id); // No competing registered owner exists yet.
      expect(await verify()).toMatchObject({ verified: false, skipReason: 'cleanup-owner-changed' });
      expect(fixture.task.metadata.deliveryRecovery).toBeUndefined();
      expect((await getAgentRecord(agent.id)).metadata.repoStateVerification.status).toBe('pending');
      expect((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(head);
      expect(await readFile(join(path, 'ignored.txt'), 'utf8')).toBe('private preserved bytes\n');
      expect(await getBranchReconcileOutcome(fixture.app.id)).toBeNull();
      return;
    }
    expect(await verify()).toMatchObject({ verified: false, skipReason: 'completion-execution-active' });
    expect(fixture.task.metadata).toMatchObject({ deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: running.id,
      hookDelivery: { selectedPaths: ['feature.txt'] } });
    const pending = await getBranchReconcileOutcome(fixture.app.id); expect(pending.retirementObligations).toHaveLength(1);
    const obligation = pending.retirementObligations[0]; expect(obligation).toMatchObject({ path, branch, head });
    expect(fixture.task.status).toBe('in_progress');
    fixture.schedule = JSON.parse(await readFile(join(fixture.root, 'schedule.json'), 'utf8')); activeAgents.delete(agent.id);
    const { buildRenewal } = await import('./cosTaskClaim.js');
    Object.assign(fixture.task.metadata, buildRenewal(fixture.task.metadata, 'fixture-instance'));
    await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task));
    const results = await Promise.all([verify(), verify()]); expect(results).toMatchObject([{ verified: true, skipReason: null }, { verified: true, skipReason: null }]);
    const outcome = await getBranchReconcileOutcome(fixture.app.id); expect(outcome.retirementObligations).toEqual([]);
    expect(outcome.retired).toHaveLength(1); const receipt = outcome.retired[0];
    expect(receipt).toMatchObject({ path, branch, head, branchDeleted: true });
    expect(await readFile(join(receipt.archiveDir, 'files', 'ignored.txt'), 'utf8')).toBe('private preserved bytes\n');
    const restored = join(scratch, 'restored.git'); await execGit(['init', '--bare', restored], scratch);
    await execGit(['bundle', 'unbundle', join(receipt.archiveDir, 'commits.bundle')], restored);
    expect((await execGit(['show', `${head}:feature.txt`], restored)).stdout).toBe('delivered original\n');
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).not.toContain(path);
    expect((await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
    expect(JSON.parse(await readFile(join(fixture.root, 'task.json'), 'utf8')).status).toBe('completed');
    await verify(); expect((await getBranchReconcileOutcome(fixture.app.id)).retired).toHaveLength(1);
  });
});
