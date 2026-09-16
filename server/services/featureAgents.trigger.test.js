import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-feature-agent-trigger-');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

vi.mock('./cos.js', () => ({
  addTask: vi.fn(),
  forceSpawnTask: vi.fn()
}));

vi.mock('./apps.js', () => ({
  getAppById: vi.fn()
}));

import { addTask, forceSpawnTask } from './cos.js';
import { getAppById } from './apps.js';
const { generateTaskFromFeatureAgent, triggerFeatureAgent, stopFeatureAgent, updateFeatureAgent } = await import('./featureAgents.js');
import { cosEvents } from './cosEvents.js';

const agent = {
  id: 'fa-example',
  name: 'Example Agent',
  description: 'Improve the example feature',
  appId: 'app-example',
  status: 'active',
  currentAgentId: null,
  lastRunAt: new Date().toISOString(),
  backoff: { currentDelayMs: 3600000, consecutiveIdles: 1, lastIdleAt: new Date().toISOString() },
  schedule: { mode: 'continuous', pauseBetweenRunsMs: 60000 },
  git: { branchName: 'feature-agent/example-fa-example', baseBranch: 'main' }
};

const dataPath = () => join(tempRoot, 'cos', 'feature-agents.json');

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(join(tempRoot, 'cos'), { recursive: true });
  writeFileSync(dataPath(), JSON.stringify({ version: 1, agents: [structuredClone(agent)] }));
  getAppById.mockResolvedValue({ id: 'app-example', repoPath: '/tmp/example-repo' });
  addTask.mockResolvedValue({ ...generateTaskFromFeatureAgent(agent) });
  forceSpawnTask.mockResolvedValue({ success: true, taskId: 'fa-run' });
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('triggerFeatureAgent', () => {
  it('queues and immediately force-spawns a manual run', async () => {
    const result = await triggerFeatureAgent(agent.id);

    expect(result).toMatchObject({ triggered: true, started: true, taskId: expect.any(String) });
    expect(addTask).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ featureAgentId: agent.id }) }),
      'internal',
      { raw: true, suppressDequeue: true }
    );
    expect(forceSpawnTask).toHaveBeenCalledWith(result.taskId);
  });

  it('force-spawns an equivalent pending task left by the scheduler', async () => {
    const pendingTask = { ...generateTaskFromFeatureAgent(agent), id: 'fa-run-existing', duplicate: true };
    addTask.mockResolvedValue(pendingTask);

    const result = await triggerFeatureAgent(agent.id);

    expect(result).toMatchObject({ triggered: true, taskId: 'fa-run-existing' });
    expect(forceSpawnTask).toHaveBeenCalledWith('fa-run-existing');
  });

  it('does not leave a pending pointer when immediate spawn is refused', async () => {
    forceSpawnTask.mockResolvedValue({ error: 'CoS daemon is stopped' });

    const result = await triggerFeatureAgent(agent.id);
    const saved = JSON.parse(await readFile(dataPath(), 'utf8'));

    expect(result).toMatchObject({ triggered: false, reason: 'CoS daemon is stopped' });
    expect(saved.agents[0].currentAgentId).toBeNull();
  });

  it('follows a relaunched run to its continuation instead of recording an error', async () => {
    // Relaunch retires the CoS agent with `success: false` and requeues the same
    // task on a new provider. Treating that as a completion flipped the feature
    // agent to `error`, banked a run that had not finished, and — because the
    // `agent:spawned` re-bind only matches a feature agent still pointing at the
    // TASK — stranded currentAgentId on the dead agent, so the continuation's
    // output never reached the feature-agent view.
    const result = await triggerFeatureAgent(agent.id);
    cosEvents.emit('agent:spawned', { taskId: result.taskId, id: 'agent-first' });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBe('agent-first');
    });

    cosEvents.emit('agent:completed', {
      id: 'agent-first',
      taskId: result.taskId,
      metadata: { featureAgentId: agent.id, featureAgentRun: true },
      result: { success: false, resumed: true, resumedTaskId: result.taskId, error: 'Relaunched by user on codex' }
    });

    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBe(result.taskId);
    });
    const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
    expect(saved.agents[0].runCount ?? 0).toBe(0);
    expect(saved.agents[0].status).toBe('active');

    // And the pointer it handed back is the one the continuation's spawn re-binds.
    cosEvents.emit('agent:spawned', { taskId: result.taskId, id: 'agent-second' });
    await vi.waitFor(async () => {
      const after = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(after.agents[0].currentAgentId).toBe('agent-second');
    });
  });

  it('does NOT hand back a stranded pause, which would wedge the agent forever', async () => {
    // `retireStrandedPausedAgents` stamps `resumed: true` on a pause whose task is
    // gone, with no `resumedTaskId` and nothing requeued. Handing back to the dead
    // `taskId` parks a pointer no `agent:spawned` can clear, and both
    // `triggerFeatureAgent` and `getDueFeatureAgents` refuse to run a feature agent
    // holding one — so the agent never runs again by schedule or by hand.
    const result = await triggerFeatureAgent(agent.id);
    cosEvents.emit('agent:spawned', { taskId: result.taskId, id: 'agent-first' });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBe('agent-first');
    });

    cosEvents.emit('agent:completed', {
      id: 'agent-first',
      taskId: result.taskId,
      metadata: { featureAgentId: agent.id, featureAgentRun: true },
      result: { success: false, resumed: true, error: 'Pause retired — its task no longer exists' },
    });

    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBeNull();
    });
    // And it is runnable again, which is the whole point.
    expect((await triggerFeatureAgent(agent.id)).triggered).toBe(true);
  });

  it('does not resurrect the pointer when the agent was stopped mid-relaunch', async () => {
    // The hand-back is a compare-and-set against the RETIRED agent's id, not a
    // blind write: `agent:completed` is delivered asynchronously, so anything that
    // legitimately moved the pointer in between must win. Stop is the reachable
    // one — it sets `currentAgentId = null` and `status: 'draft'`, and a hand-back
    // that wrote the task id over that leaves a STOPPED feature agent holding a
    // pointer, which `triggerFeatureAgent` and `getDueFeatureAgents` both read as
    // "a run is already in flight" — so Stop would quietly disable the agent.
    const result = await triggerFeatureAgent(agent.id);
    cosEvents.emit('agent:spawned', { taskId: result.taskId, id: 'agent-first' });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBe('agent-first');
    });

    await stopFeatureAgent(agent.id);

    cosEvents.emit('agent:completed', {
      id: 'agent-first',
      taskId: result.taskId,
      metadata: { featureAgentId: agent.id, featureAgentRun: true },
      result: { success: false, resumed: true, resumedTaskId: result.taskId, error: 'Relaunched by user' },
    });

    // Deterministic settle, not a sleep: the listener reaches `withLock` before
    // `emit()` returns (nothing awaits ahead of it), so anything queued onto that
    // same mutex afterwards resolves strictly after the hand-back would have
    // written. `updateFeatureAgent` takes the lock and never touches
    // `currentAgentId`, so it orders the assertion without destroying the evidence.
    await updateFeatureAgent(agent.id, { description: 'settle' });

    const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
    expect(saved.agents[0].currentAgentId).toBeNull();
    expect(saved.agents[0].status).toBe('draft');
  });

  it('points at the REPLACEMENT task when a resume could not reuse the paused one', async () => {
    // `resumeAgent`'s new-task mode queues a fresh task (inheriting this feature
    // agent's metadata) and reports it as `resumedTaskId`. Handing back the
    // retired `taskId` would leave a pointer nothing will ever spawn.
    const result = await triggerFeatureAgent(agent.id);
    cosEvents.emit('agent:spawned', { taskId: result.taskId, id: 'agent-first' });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBe('agent-first');
    });

    cosEvents.emit('agent:completed', {
      id: 'agent-first',
      taskId: result.taskId,
      metadata: { featureAgentId: agent.id, featureAgentRun: true },
      result: { success: false, resumed: true, resumedTaskId: 'task-replacement', error: 'Relaunched by user' }
    });

    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBe('task-replacement');
    });
  });

  it('clears the active pointer and records the run after CoS completion', async () => {
    const result = await triggerFeatureAgent(agent.id);

    cosEvents.emit('agent:spawned', { taskId: result.taskId, id: 'agent-real' });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].currentAgentId).toBe('agent-real');
    });
    cosEvents.emit('agent:completed', {
      metadata: { featureAgentId: agent.id, featureAgentRun: true },
      result: { success: true }
    });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
      expect(saved.agents[0].runCount).toBe(1);
    });
    const saved = JSON.parse(await readFile(dataPath(), 'utf8'));
    expect(saved.agents[0].currentAgentId).toBeNull();
  });
});
