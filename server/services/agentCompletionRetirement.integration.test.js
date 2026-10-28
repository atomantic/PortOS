/** No-inventory completion must retain one exact obligation through execution release and in-place removal. */
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, sep, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { storedForm } from '../lib/cosTaskRows.js';
import { PREGATE_REPORT_PATH, writePregateReport } from '../../scripts/lib/pregateReport.js';
const fixture = vi.hoisted(() => ({ root: null, app: null, forge: null, task: null, agents: {}, schedule: null, raceTaskEdit: false, inventoryAlias: false }));
async function persistTask() {
  fixture.task = { ...storedForm(fixture.task, 'user'), taskType: 'user' };
  await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task));
}
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-completion-retirement-state-') }));
// Keep real Git and teardown; vary only the lexical spelling returned by its
// inventory adapter, like Git-forward versus native Windows separators.
vi.mock('./worktreeManager.js', async original => {
  const actual = await original();
  return { ...actual, listWorktrees: async (...args) => (await actual.listWorktrees(...args)).map(tree =>
    fixture.inventoryAlias && tree.branch === 'refs/heads/claim/issue-42' ? { ...tree, path: `${tree.path}${sep}.` } : tree) };
});
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
    await persistTask(); return fixture.task;
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
const { verifyAgentRepoState, sweepRepoStateVerifications, resumeDeferredRepoStateVerifications } = await import('./agentRepoStateVerification.js');
const { bindCompletionTaskDispatch, prepareCompletionTaskHandoff } = await import('./agentCompletionTaskHandoff.js');
const { completeAgent, getAgentRecord } = await import('./cosAgentLifecycle.js');
const { getBranchReconcileOutcome } = await import('./taskSchedule.js');
const { activeAgents } = await import('./agentState.js');
const { PATHS } = await import('../lib/paths.js');
const { cosEvents } = await import('./cosEvents.js');
afterAll(cleanupTempDataRoots);
let scratch;
afterEach(async () => { fixture.inventoryAlias = false; activeAgents.clear(); if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); });
describe('completion to in-place retirement (real Git and persisted service state)', () => {
  it.each(['fallback', 'wake', 'wake-paused', 'wake-backoff'])('drains context-less legacy handoffs with bounded recovery: %s', async scenario => {
    scratch = await mkdtemp(join(tmpdir(), 'portos-completion-sweep-'));
    fixture.root = PATHS.data; await mkdir(fixture.root, { recursive: true });
    fixture.task = { id: 'sweep-task', taskType: 'user', status: 'completed', metadata: { totalSpawnCount: 7, spawnFailedCount: 7 } };
    await writeFile(join(fixture.root, 'task.json'), JSON.stringify(fixture.task));
    fixture.agents = Object.fromEntries(Array.from({ length: 11 }, (_, index) => {
      const id = `sweep-agent-${index}`;
      return [id, { id, taskId: fixture.task.id, status: 'completed', startedAt: '2020-01-01T00:00:00.000Z',
        result: { success: false }, metadata: { repoStateVerification: { status: 'completed', checkedAt: '2020-01-01T00:00:01.000Z' },
          completionCleanup: { version: 1, status: 'pending', updatedAt: new Date(1600000000000 + index).toISOString(),
            stages: { pipeline: { status: 'failed', retryable: false, reason: 'external-state-unknown' } } } } }];
    }));
    const waiting = fixture.agents['sweep-agent-10'].metadata.completionCleanup.updatedAt;
    if (scenario !== 'fallback') {
      const originalBudget = { ...fixture.task.metadata };
      if (scenario === 'wake-backoff') Object.assign(fixture.agents['sweep-agent-10'].metadata.completionCleanup,
        { replayAttempts: 5, retryAt: new Date(Date.now() + 60_000).toISOString() });
      let gates = 0;
      const blocked = async () => {
        if (++gates === 2 && scenario === 'wake') {
          fixture.agents['new-arrival'] = { ...structuredClone(fixture.agents['sweep-agent-10']), id: 'new-arrival' };
        }
        return scenario === 'wake-paused' && gates > 1 ? 'daemon paused' : null;
      };
      const first = resumeDeferredRepoStateVerifications(blocked);
      expect(resumeDeferredRepoStateVerifications(blocked)).toBe(first);
      const result = await first;
      expect(result).toMatchObject({ checked: scenario === 'wake' ? 11 : 10,
        pendingAtStart: scenario === 'wake-backoff' ? 10 : 11 });
      fixture.agents = JSON.parse(await readFile(join(fixture.root, 'agents-state.json'), 'utf8')).agents;
      expect(fixture.task.metadata).toEqual(originalBudget);
      expect(Object.values(fixture.agents).every(agent => agent.result.success === false)).toBe(true);
      expect(fixture.agents['sweep-agent-0'].metadata.completionCleanup.replayAttempts).toBe(1);
      if (scenario === 'wake') {
        expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.status).toBe('abandoned');
        expect(fixture.agents['new-arrival'].metadata.completionCleanup.lastAttemptAt).toBeUndefined();
      } else {
        expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.updatedAt).toBe(waiting);
        if (scenario === 'wake-backoff') expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.replayAttempts).toBe(5);
        else expect(result.skipReason).toBe('daemon paused');
      }
      return;
    }

    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 10, pendingAtStart: 11 });
    fixture.agents = JSON.parse(await readFile(join(fixture.root, 'agents-state.json'), 'utf8')).agents;
    expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.updatedAt).toBe(waiting);
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1, pendingAtStart: 1 });
    fixture.agents = JSON.parse(await readFile(join(fixture.root, 'agents-state.json'), 'utf8')).agents;
    expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.lastAttemptAt).toEqual(expect.any(String));
    expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.stages.pipeline).toMatchObject({ status: 'failed', retryable: false });
    expect(fixture.agents['sweep-agent-10'].metadata.completionCleanup.status).toBe('abandoned');
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0, pendingAtStart: 0 });
    expect(fixture.task.status).toBe('completed');
  });

  it.each(['unchanged', 'lexical-workspace', 'changed-dispatch', 'concurrent-task-edit', 'claim-reacquired'])('recovers the missing task handoff after restart with exact task CAS (%s)', async scenario => {
    const changed = !['unchanged', 'lexical-workspace'].includes(scenario);
    fixture.raceTaskEdit = false;
    fixture.inventoryAlias = scenario === 'lexical-workspace';
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
    await writeFile(join(repo, '.git', 'info', 'exclude'), '/.cache/\n');
    // The mandatory pre-push gate leaves runtime evidence behind. A neighboring
    // ignored file is still unique content and must hold retirement in place.
    writePregateReport(path, { version: 3, validationMode: 'focused', passed: true });
    const privatePath = join(path, '.cache/pregate/private-notes.txt');
    await writeFile(privatePath, 'private preserved bytes\n');
    fixture.forge = { repository: 'github.com/example/repo', prUrl: 'https://github.com/example/repo/pull/42', prHead: head, changeBase: (await execGit(['rev-parse', `${head}^`], repo)).stdout.trim(), firstCommit: head,
      mergeCommit: defaultHead, defaultBranch: 'main', defaultHead, remoteHead: null, changedPaths: ['feature.txt'] };
    fixture.app = { id: 'app-completion', repoPath: repo }; fixture.schedule = { tasks: {}, executions: {} };
    fixture.task = { id: running.taskId, taskType: 'user', status: 'in_progress', priority: 'MEDIUM', description: 'Complete example delivery', metadata: { app: fixture.app.id, openPR: true,
      prCompletion: 'review-then-merge', claimedBy: 'fixture-instance', claimedAt: startedAt, totalSpawnCount: 1,
      lastSpawnedAt: startedAt, updatedAt: startedAt } };
    fixture.agents = { [running.id]: running };
    activeAgents.set(running.id, { task: fixture.task });
    if (scenario === 'lexical-workspace') await persistTask();
    expect(await bindCompletionTaskDispatch(running.id, fixture.task)).toBe(true);
    // The dispatcher binds the numeric write result, but completion reads the
    // persisted scalar text. Losing this handoff misclassifies a clean run as
    // an orphan and exhausts its retry budget after successful retirement.
    await persistTask();
    expect(fixture.task.metadata.totalSpawnCount).toBe('1');
    expect(await prepareCompletionTaskHandoff(await getAgentRecord(running.id), { hookDelivery: { selectedPaths: ['feature.txt'] } })).toBe(true);
    if (scenario === 'unchanged') {
      // Receipts from a numeric task snapshot must replay against stored text,
      // while the final compare-and-swap still uses the exact current values.
      const intent = fixture.agents[running.id].metadata.completionCleanup.taskHandoff;
      intent.expected = intent.expected.map(([key, value]) => [key, key === 'totalSpawnCount' ? Number(value) : value]);
    }
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
      expect(await readFile(privatePath, 'utf8')).toBe('private preserved bytes\n');
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
    // Merge evidence cannot account for the only copy of an ignored file.
    expect(await verify()).toMatchObject({ verified: false, skipReason: 'checkout-ignored-payload-unverified' });
    expect(await readFile(privatePath, 'utf8')).toBe('private preserved bytes\n');
    await rm(privatePath);
    expect(existsSync(join(path, PREGATE_REPORT_PATH))).toBe(true);
    const results = await Promise.all([verify(), verify()]); expect(results).toMatchObject([{ verified: true, skipReason: null }, { verified: true, skipReason: null }]);
    const outcome = await getBranchReconcileOutcome(fixture.app.id); expect(outcome.retirementObligations).toEqual([]);
    expect(outcome.retired).toHaveLength(1); const receipt = outcome.retired[0];
    expect(receipt).toMatchObject({ path, branch, head, branchDeleted: true, archiveDir: null });
    expect(existsSync(join(PATHS.cos, 'held-checkout-archives'))).toBe(false);
    const { listWorktrees } = await import('./worktreeManager.js');
    expect((await listWorktrees(repo)).some(tree => resolve(tree.path) === resolve(path))).toBe(false);
    expect((await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
    expect(JSON.parse(await readFile(join(fixture.root, 'task.json'), 'utf8')).status).toBe('completed');
    expect(existsSync(join(path, PREGATE_REPORT_PATH))).toBe(false);
    await verify(); expect((await getBranchReconcileOutcome(fixture.app.id)).retired).toHaveLength(1);
  // Completion capture, held retirement, recovery and fresh receipt proof are
  // separate real-Git workflows. Keep their existing public-boundary budget.
  }, 60_000);
});
