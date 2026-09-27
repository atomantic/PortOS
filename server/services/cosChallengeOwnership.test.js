import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

const fixture = vi.hoisted(() => ({ root: null, state: null, ready: [] }));
vi.mock('../lib/fileUtils.js', async (original) => {
  const actual = await original();
  const { makePathsProxy, createTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  fixture.root = createTempDataRoot('portos-challenge-ownership-');
  return makePathsProxy(actual, { dataRoot: fixture.root, extraOverrides: { root: fixture.root } });
});
vi.mock('./cosState.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    isDaemonRunning: () => true,
    loadState: vi.fn(async () => fixture.state),
  };
});
vi.mock('./cos.js', async () => {
  const store = await import('./cosTaskStore.js');
  return { getTaskById: store.getTaskById, updateTask: store.updateTask, isRunning: () => false };
});
vi.mock('./instances.js', async () => {
  const { mockNoPeers } = await import('../lib/mockPathsDataRoot.js');
  return mockNoPeers();
});
vi.mock('./sharing/peerSync.js', async () => {
  const { mockNoPeerSync } = await import('../lib/mockPathsDataRoot.js');
  return mockNoPeerSync();
});
vi.mock('./notifications.js', () => ({ removeByMetadata: vi.fn(async () => 0) }));
vi.mock('./codeReview.js', () => ({ runLocalCodeReview: vi.fn(), getCodeReviewDefaults: vi.fn() }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'instance-test') }));
vi.mock('./agentPromptBuilder.js', () => ({ getAppWorkspace: vi.fn() }));
vi.mock('./appActivity.js', () => ({ releaseAppReviewMarker: vi.fn(async () => {}) }));
vi.mock('./toolStateMachine.js', () => ({
  createToolExecution: vi.fn(() => ({ id: 'tool-test' })),
  startExecution: vi.fn(), completeExecution: vi.fn(), errorExecution: vi.fn(),
}));
vi.mock('./executionLanes.js', () => ({
  determineLane: () => 'background', acquire: () => ({ success: true }), release: vi.fn(),
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: {
    emit: (event, task) => { if (event === 'task:ready') fixture.ready.push(task); },
    on: vi.fn(), off: vi.fn(),
  },
  emitLog: vi.fn(),
}));
vi.mock('./onDemandDrain.js', () => ({ drainOnDemandRequests: async () => ({ schedule: { tasks: {} } }) }));
vi.mock('./domainUsage.js', () => ({ getDomainBudgetStatus: async () => ({ budget: {}, usage: {} }) }));
vi.mock('./cosLocalEndpointSlots.js', () => ({
  buildLocalEndpointSlotContext: async () => ({
    endpointForAgent: () => null, resolveLocalEndpoint: () => null, limit: Infinity,
  }),
}));

import { addTask, updateTask, challengeTask, resolveTaskChallenge, getTaskById, __resetTaskCache } from './cosTaskStore.js';
import { activeAgents, runnerAgents } from './agentState.js';
import { withStateLock } from './cosState.js';
import { prepareAgentSpawn } from './agentSpawnPreparation.js';
const { dequeueNextTask } = await vi.importActual('./cos.js');

beforeEach(() => {
  __resetTaskCache();
  activeAgents.clear();
  runnerAgents.clear();
  fixture.ready = [];
  const root = relative(fixture.root, mkdtempSync(join(fixture.root, 'case-')));
  fixture.state = {
    config: { userTasksFile: join(root, 'TASKS.md'), cosTasksFile: join(root, 'COS-TASKS.md'), maxConcurrentAgents: 4 },
    agents: {},
    paused: false,
  };
});
afterAll(async () => {
  activeAgents.clear();
  runnerAgents.clear();
  await rm(fixture.root, { recursive: true, force: true });
});

async function seedOwner({ running = true } = {}) {
  const task = await addTask({ id: 'task-example', description: 'Example disputed work' });
  await updateTask(task.id, { status: 'in_progress' });
  fixture.state.agents['agent-owner'] = {
    id: 'agent-owner', taskId: task.id, status: running ? 'running' : 'completed',
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  };
  return task;
}

// Run the real dequeue engine, then its task:ready dispatch admission. No
// listener starts a provider or process; the emitted tasks are captured above.
async function dequeue() {
  fixture.ready = [];
  await dequeueNextTask();
  const prepared = await Promise.all(fixture.ready.map(task => prepareAgentSpawn(task)));
  return prepared.filter(Boolean);
}

describe('challenge ownership workflow', () => {
  it('keeps an old running owner through upheld resolution and dequeue, rejecting stale direct dispatch too', async () => {
    const task = await seedOwner();
    await challengeTask(task.id, { reason: 'incorrect rejection' });
    const resolved = await resolveTaskChallenge(task.id, { outcome: 'upheld' });
    expect(resolved.status).toBe('in_progress');
    expect(await dequeue()).toEqual([]);
    expect(await prepareAgentSpawn(task)).toBeNull();
    expect(Object.keys(fixture.state.agents)).toEqual(['agent-owner']);
    // Even an independent requeue cannot dispatch a second run.
    await updateTask(task.id, { status: 'pending' });
    expect(await dequeue()).toEqual([]);
  });

  it('requeues once when the owner has been retired, allowing dead-owner recovery', async () => {
    const task = await seedOwner({ running: false });
    await challengeTask(task.id, { reason: 'incorrect rejection' });
    const results = await Promise.all([
      resolveTaskChallenge(task.id, { outcome: 'upheld' }),
      resolveTaskChallenge(task.id, { outcome: 'upheld' }),
    ]);
    expect(results.map(r => r.status || r.code)).toEqual(['pending', 'NOT_CHALLENGED']);
    expect(await dequeue()).toHaveLength(1);
  });

  it.each(['direct', 'runner'])('protects %s completion bookkeeping after the durable agent completes', async (mode) => {
    const task = await seedOwner({ running: false });
    const owners = mode === 'direct' ? activeAgents : runnerAgents;
    owners.set('agent-owner', mode === 'direct' ? { task } : { taskId: task.id });
    await challengeTask(task.id, { reason: 'incorrect rejection' });
    expect((await resolveTaskChallenge(task.id, { outcome: 'upheld' })).status).toBe('in_progress');
    expect(await prepareAgentSpawn(task)).toBeNull();
    owners.delete('agent-owner');
    await updateTask(task.id, { status: 'pending' });
    expect(await dequeue()).toHaveLength(1);
  });

  it.each(['completion-first', 'resolution-first'])('does not regress completion when racing resolution (%s)', async (order) => {
    const task = await seedOwner();
    await challengeTask(task.id, { reason: 'incorrect rejection' });
    let release;
    const held = withStateLock(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const complete = () => updateTask(task.id, { status: 'completed' });
    const resolve = () => resolveTaskChallenge(task.id, { outcome: 'upheld' });
    const first = order === 'completion-first' ? complete() : resolve();
    // updateTask performs pause preparation before queuing its write.
    await new Promise(setImmediate);
    const second = order === 'completion-first' ? resolve() : complete();
    release();
    await Promise.all([held, first, second]);
    expect((await getTaskById(task.id)).status).toBe('completed');
  });

  it('serializes challenge budget checks against competing requests', async () => {
    const task = await seedOwner();
    const results = await Promise.all([
      challengeTask(task.id, { reason: 'first' }), challengeTask(task.id, { reason: 'second' }),
    ]);
    expect(results.map(r => r.status || r.code)).toEqual(['challenged', 'CHALLENGE_EXHAUSTED']);
  });
});
