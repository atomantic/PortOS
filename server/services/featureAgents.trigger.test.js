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
const { generateTaskFromFeatureAgent, triggerFeatureAgent } = await import('./featureAgents.js');
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
