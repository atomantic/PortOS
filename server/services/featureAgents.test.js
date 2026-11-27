import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isInternalTaskId } from '../lib/taskParser.js';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

/**
 * Tests for feature agents scheduling and task generation.
 */

const tempRoot = createTempDataRoot('portos-feature-agent-due-');

vi.mock('../lib/paths.js', async (importActual) => makePathsProxy(await importActual(), { dataRoot: () => tempRoot }));
vi.mock('./cos/cosTaskStore.js', () => ({ addTask: vi.fn(), deleteTask: vi.fn() }));
vi.mock('./cos/cosAgentLifecycle.js', async (importActual) => ({
  ...await importActual(),
  getAgentRecord: vi.fn(),
  getAgents: vi.fn()
}));
vi.mock('./agent/agentManagement.js', () => ({ killAgent: vi.fn() }));
vi.mock('./worktreeManager.js', () => ({ removePersistentWorktree: vi.fn() }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn() }));

const { getAgentRecord, getAgents } = await import('./cos/cosAgentLifecycle.js');
import { addTask, deleteTask } from './cos/cosTaskStore.js';
import { killAgent } from './agent/agentManagement.js';
import { removePersistentWorktree } from './worktreeManager.js';
import { getAppById } from './apps.js';
import { cosEvents } from './cos/cosEvents.js';

const {
  deleteFeatureAgent, generateTaskFromFeatureAgent, getDueFeatureAgents, getFeatureAgent, getFeatureAgentOutput,
  getFeatureAgentRuns, queueFeatureAgentTask, resumeFeatureAgent, stopFeatureAgent, updateFeatureAgent, withFeatureAgentDispatch
} = await import('./featureAgents.js');

const featureAgentFile = join(tempRoot, 'cos', 'feature-agents.json');
function seedAgent(agent) {
  mkdirSync(join(tempRoot, 'cos'), { recursive: true });
  writeFileSync(featureAgentFile, JSON.stringify({ version: 1, agents: [agent] }));
}

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('Feature Agent Scheduling (getDueFeatureAgents)', () => {
  const baseAgent = {
    id: 'fa-sched',
    status: 'active',
    currentAgentId: null,
    lastRunAt: null,
    schedule: { mode: 'continuous', pauseBetweenRunsMs: 60000 }
  };

  const isDue = async (agent) => {
    seedAgent(agent);
    return (await getDueFeatureAgents()).some(a => a.id === agent.id);
  };

  it('should be due when never run before', async () => {
    expect(await isDue(baseAgent)).toBe(true);
  });

  it('should not be due when recently run (continuous)', async () => {
    expect(await isDue({ ...baseAgent, lastRunAt: new Date().toISOString() })).toBe(false);
  });

  it('should be due when pause elapsed (continuous)', async () => {
    expect(await isDue({ ...baseAgent, lastRunAt: new Date(Date.now() - 120000).toISOString() })).toBe(true);
  });

  it('should respect interval mode', async () => {
    const agent = {
      ...baseAgent,
      schedule: { mode: 'interval', intervalMs: 3600000 },
      lastRunAt: new Date(Date.now() - 1800000).toISOString() // 30min ago
    };
    expect(await isDue(agent)).toBe(false);
    expect(await isDue({ ...agent, lastRunAt: new Date(Date.now() - 7200000).toISOString() })).toBe(true);
  });

  it('should skip non-active agents', async () => {
    expect(await isDue({ ...baseAgent, status: 'draft' })).toBe(false);
    expect(await isDue({ ...baseAgent, status: 'paused' })).toBe(false);
  });

  it('should skip standby agents', async () => {
    expect(await isDue({ ...baseAgent, autonomyLevel: 'standby' })).toBe(false);
  });

  it('should skip agents already running', async () => {
    expect(await isDue({ ...baseAgent, currentAgentId: 'agent-123' })).toBe(false);
  });
});

describe('Feature Agent lifecycle', () => {
  const agent = {
    id: 'fa-lifecycle',
    name: 'Example Feature',
    appId: 'app-example',
    status: 'active',
    currentAgentId: null,
    git: { branchName: 'feature-agent/example', baseBranch: 'main' }
  };
  const worktree = join(tempRoot, 'cos', 'feature-agents', agent.id, 'worktree');
  const liveRun = { id: 'agent-lifecycle', taskId: 'queued-lifecycle', status: 'running', metadata: { featureAgentId: agent.id, featureAgentRun: true } };

  beforeEach(() => {
    vi.resetAllMocks();
    seedAgent(agent);
    getAgentRecord.mockResolvedValue(null);
    getAgents.mockResolvedValue([]);
    deleteTask.mockResolvedValue({ success: true });
    removePersistentWorktree.mockResolvedValue(undefined);
    getAppById.mockResolvedValue({ repoPath: join(tempRoot, 'example-repo') });
  });

  it.each(['draft', 'active', 'error'])('resumes only paused agents, preserving %s', async (status) => {
    seedAgent({ ...agent, status });
    expect(await resumeFeatureAgent(agent.id)).toMatchObject({ status });
    expect(await getFeatureAgent(agent.id)).toMatchObject({ status });
  });

  it('persists and announces a paused agent resuming', async () => {
    seedAgent({ ...agent, status: 'paused' });
    const event = new Promise(resolve => cosEvents.once('feature-agent:status', resolve));
    await expect(resumeFeatureAgent(agent.id)).resolves.toMatchObject({ status: 'active' });
    await expect(event).resolves.toEqual({ id: agent.id, status: 'active', name: agent.name });
    await expect(getFeatureAgent(agent.id)).resolves.toMatchObject({ status: 'active' });
  });

  it('emits the persisted configuration update', async () => {
    const event = new Promise(resolve => cosEvents.once('feature-agent:status', resolve));
    await updateFeatureAgent(agent.id, { name: 'Renamed Feature', git: { autoPR: false } });
    await expect(event).resolves.toEqual({ id: agent.id, status: 'active', name: 'Renamed Feature' });
    await expect(getFeatureAgent(agent.id)).resolves.toMatchObject({
      name: 'Renamed Feature', git: { ...agent.git, autoPR: false }
    });
  });

  it('kills a live run before stopping and ignores its delayed completion', async () => {
    seedAgent({ ...agent, currentAgentId: liveRun.id, runCount: 0 });
    getAgentRecord.mockResolvedValue(liveRun);
    killAgent.mockImplementation(async () => {
      await expect(getFeatureAgent(agent.id)).resolves.toMatchObject({ status: 'active', currentAgentId: liveRun.id });
      cosEvents.emit('agent:completed', { ...liveRun, result: { success: false } });
    });

    await expect(stopFeatureAgent(agent.id)).resolves.toMatchObject({ status: 'draft', currentAgentId: null });
    expect(killAgent).toHaveBeenCalledWith(liveRun.id);
    expect(deleteTask).toHaveBeenCalledWith(liveRun.taskId, 'internal');
    // Taking the same write lock settles the completion queued by killAgent.
    await updateFeatureAgent(agent.id, { name: agent.name });
    await expect(getFeatureAgent(agent.id)).resolves.toMatchObject({ status: 'draft', currentAgentId: null, runCount: 0 });
    await expect(getFeatureAgentRuns(agent.id)).resolves.toEqual([]);
  });

  it('cancels a queued run before resetting its state and refuses a stale dispatch', async () => {
    const task = generateTaskFromFeatureAgent(agent);
    addTask.mockResolvedValue(task);
    await queueFeatureAgentTask(task);
    deleteTask.mockImplementation(async () => {
      await expect(getFeatureAgent(agent.id)).resolves.toMatchObject({ currentAgentId: task.id });
      return { success: true };
    });

    await stopFeatureAgent(agent.id);
    const spawn = vi.fn();
    await expect(withFeatureAgentDispatch(task, spawn)).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(deleteTask).toHaveBeenCalledWith(task.id, 'internal');
    expect(killAgent).not.toHaveBeenCalled();
  });

  it('waits for a task already dispatching, then kills its live owner before deleting the worktree', async () => {
    mkdirSync(worktree, { recursive: true });
    seedAgent({ ...agent, currentAgentId: liveRun.taskId });
    const dispatchStarted = Promise.withResolvers();
    const processStarted = Promise.withResolvers();
    const dispatch = withFeatureAgentDispatch({
      id: liveRun.taskId, metadata: liveRun.metadata
    }, async () => {
      dispatchStarted.resolve();
      await processStarted.promise;
      getAgents.mockResolvedValue([liveRun]);
    });
    await dispatchStarted.promise;
    const deleting = deleteFeatureAgent(agent.id);
    processStarted.resolve();
    await dispatch;
    await expect(deleting).resolves.toBe(true);

    expect(killAgent).toHaveBeenCalledWith(liveRun.id);
    expect(removePersistentWorktree).toHaveBeenCalledWith(agent.id, join(tempRoot, 'example-repo'), agent.git.branchName);
    expect(killAgent.mock.invocationCallOrder[0]).toBeLessThan(removePersistentWorktree.mock.invocationCallOrder[0]);
    expect(existsSync(worktree)).toBe(false);
    await expect(getFeatureAgent(agent.id)).resolves.toBeNull();
  });

  it('cancels the task when a paused run has already exited', async () => {
    seedAgent({ ...agent, currentAgentId: liveRun.id });
    getAgentRecord.mockResolvedValue({ ...liveRun, status: 'paused' });
    killAgent.mockRejectedValue(Object.assign(new Error('Agent not found'), { status: 404, code: 'NOT_FOUND' }));

    await expect(stopFeatureAgent(agent.id)).resolves.toMatchObject({ status: 'draft', currentAgentId: null });
    expect(killAgent).toHaveBeenCalledWith(liveRun.id);
    expect(deleteTask).toHaveBeenCalledWith(liveRun.taskId, 'internal');
  });

  it('cancels a queued continuation before deletion', async () => {
    seedAgent({ ...agent, currentAgentId: liveRun.id });
    getAgentRecord.mockResolvedValue({ ...liveRun, status: 'completed', result: { resumed: true, resumedTaskId: 'continuation-task' } });

    await expect(deleteFeatureAgent(agent.id)).resolves.toBe(true);
    expect(deleteTask).toHaveBeenCalledWith('continuation-task', 'internal');
    expect(killAgent).not.toHaveBeenCalled();
  });

  it('keeps the feature agent and worktree when process termination fails', async () => {
    mkdirSync(worktree, { recursive: true });
    seedAgent({ ...agent, currentAgentId: liveRun.id });
    getAgentRecord.mockResolvedValue(liveRun);
    killAgent.mockRejectedValue(new Error('Runner unavailable'));

    await expect(deleteFeatureAgent(agent.id)).rejects.toThrow('Runner unavailable');
    await expect(getFeatureAgent(agent.id)).resolves.toMatchObject({ currentAgentId: liveRun.id });
    expect(removePersistentWorktree).not.toHaveBeenCalled();
    expect(existsSync(worktree)).toBe(true);
  });

  it('treats an already missing queued task as settled', async () => {
    seedAgent({ ...agent, currentAgentId: liveRun.taskId });
    deleteTask.mockResolvedValue({ error: 'Task not found' });
    await expect(stopFeatureAgent(agent.id)).resolves.toMatchObject({ status: 'draft', currentAgentId: null });
  });

  it('bounds live and archived output by both lines and bytes', async () => {
    const agentsDir = join(tempRoot, 'cos', 'agents');
    const liveDir = join(agentsDir, liveRun.id);
    const archiveDate = '2026-01-01';
    const archivedId = 'agent-archived';
    const archiveDir = join(agentsDir, archiveDate, archivedId);
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(agentsDir, 'index.json'), JSON.stringify({ [archivedId]: archiveDate }));
    const lines = Array.from({ length: 615 }, (_, i) => `line-${i + 1}`);
    for (const dir of [liveDir, archiveDir]) writeFileSync(join(dir, 'output.txt'), `${lines.join('\n')}\n`);

    for (const agentId of [liveRun.id, archivedId]) {
      seedAgent({ ...agent, currentAgentId: agentId });
      await expect(getFeatureAgentOutput(agent.id)).resolves.toEqual({ agentId, output: lines.slice(-500).join('\n') });
    }

    writeFileSync(join(archiveDir, 'output.txt'), 'a'.repeat(1024 * 1024) + 'end');
    const { output } = await getFeatureAgentOutput(agent.id);
    expect(output).toHaveLength(512 * 1024);
    expect(output.endsWith('end')).toBe(true);
  });
});

describe('Feature Agent Task Generation', () => {
  const agent = {
    id: 'fa-abc123',
    name: 'UI Agent',
    description: 'Polish UI',
    priority: 'HIGH',
    appId: 'app-001',
    providerId: 'prov-1',
    model: 'opus',
    effort: 'high'
  };

  it('should generate task with correct metadata', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.metadata.featureAgentId).toBe('fa-abc123');
    expect(task.metadata.featureAgentRun).toBe(true);
    expect(task.metadata.app).toBe('app-001');
    expect(task.metadata.effort).toBe('high');
  });

  it('should use agent priority', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.priority).toBe('HIGH');
  });

  it('should default to MEDIUM priority', () => {
    const task = generateTaskFromFeatureAgent({ ...agent, priority: undefined });
    expect(task.priority).toBe('MEDIUM');
  });

  it('should be an internal pending task', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(isInternalTaskId(task.id)).toBe(true);
    expect(task.taskType).toBe('internal');
    expect(task.status).toBe('pending');
    expect(task.approvalRequired).toBe(false);
  });

  it('should include feature agent description', () => {
    const task = generateTaskFromFeatureAgent(agent);
    expect(task.description).toContain('UI Agent');
    expect(task.description).toContain('Polish UI');
  });
});
