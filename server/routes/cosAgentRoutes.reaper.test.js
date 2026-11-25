/**
 * `GET /api/cos/agents` as the first observer of a dead agent (#18637).
 *
 * A list read is one of the callers of the single dead-agent reaper, and is
 * often the first to notice a dead record after a restart. It must retire that
 * record with everything the orphan path knows (a runner completion receipt is
 * a finished run; a host-shutdown marker is an interruption, not a failure),
 * finalize it exactly once, and never retire a run that is still alive.
 *
 * These cases drive the real route, boot hook slot, orphan sweep, completion
 * router, `retireDeadAgent`, `completeAgent`, orphan-retry decision, agent
 * state and task store over a temp data root. Only what leaves the process is
 * doubled: the runner probe, git, the run ledger, and the daemon's dispatch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-agent-reaper-') }));
afterAll(cleanupTempDataRoots);

// The runner is a separate process; `listed` is what its GET /agents answers,
// or the error a restarting runner fails the probe with.
const runner = vi.hoisted(() => ({ listed: [] }));
vi.mock('../services/cos/cosRunnerClient.js', async original => ({
  ...(await original()),
  getActiveAgentsFromRunner: vi.fn(async () => {
    if (runner.listed instanceof Error) throw runner.listed;
    return runner.listed;
  }),
}));
// The daemon and its dispatch loop: retiring an agent wakes them, nothing here runs them.
vi.mock('../services/cos/cos.js', () => ({ forceSpawnTask: vi.fn() }));
vi.mock('../services/cos/cosTaskGenerator.js', () => ({ evaluateTasks: vi.fn(async () => {}) }));
vi.mock('../services/agent/agentRunEventLog.js', () => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('../services/agent/agentRunTracking.js', () => ({ completeAgentRun: vi.fn(async () => {}) }));
vi.mock('../services/domainUsage.js', () => ({ recordDomainUsage: vi.fn(async () => {}) }));
// Git: no commit landed during the dead run, and it left no worktree to resume.
vi.mock('../lib/gitCommitProbe.js', async original => ({ ...(await original()), committedDuringRun: vi.fn(async () => false) }));
vi.mock('../services/agent/agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(async () => {}),
  resolveTaskResumePatch: vi.fn(async () => ({})),
  releaseRetryHold: vi.fn(async () => ({})),
}));

import cosAgentRoutes from './cosAgentRoutes.js';
import { registerCosOrphanRecoveryHandlers } from '../services/bootHookRegistry.js';
import { cleanupOrphanedAgents, handleOrphanedTask } from '../services/agent/agentManagement.js';
import { handleAgentCompletion } from '../services/agent/agentLifecycle.js';
import { appendRunEvent } from '../services/agent/agentRunEventLog.js';
import { activeAgents, completingAgents, runnerAgents, spawningTasks } from '../services/agent/agentState.js';
import { getAgentRecord, registerAgent, updateAgent } from '../services/cos/cosAgentLifecycle.js';
import { cosEvents } from '../services/cos/cosEvents.js';
import { addTask, getTaskById } from '../services/cos/cosTaskStore.js';
import { hostShutdownMarkerPath, writeHostShutdownMarker } from '../lib/hostShutdown.js';
import { PATHS } from '../lib/paths.js';

const DEAD_PID = 2147483646;
const SWEEP_INTERVAL_MS = 15_000;
const SPAWNED_AT = '2026-01-01T00:00:00.000Z';

const app = express();
app.use(express.json());
app.use('/api/cos', cosAgentRoutes);

// The route starts the sweep and does not wait for it. The slot hands back the
// very promise the route started, so a case can only settle a sweep the list
// read began: a second, test-started sweep would hide a route that began none.
const sweeps = [];
const completedEvents = [];
const onCompleted = agent => completedEvents.push(agent);
let now = Date.now();

async function listAgentsAndSettleItsSweep() {
  now += SWEEP_INTERVAL_MS;
  const before = sweeps.length;
  const response = await request(app).get('/api/cos/agents');
  expect(response.status).toBe(200);
  expect(sweeps).toHaveLength(before + 1);
  await sweeps.at(-1);
  return response;
}

// A task in the state a real dispatch leaves it, and the receipt that dispatch
// binds on its agent: orphan recovery only retries a task for its latest dispatch.
async function dispatchTask(id, metadata = {}) {
  const dispatched = { lastSpawnedAt: SPAWNED_AT, totalSpawnCount: 1, ...metadata };
  await addTask({ id, status: 'in_progress', priority: 'MEDIUM', priorityValue: 2, description: `Reaper fixture ${id}`, metadata: dispatched }, 'user', { raw: true });
  return { completionTaskDispatch: { taskId: id, taskType: 'user', expected: [
    ['claimedBy', 'fixture-instance'], ['claimedAt', SPAWNED_AT], ['lastSpawnedAt', SPAWNED_AT], ['totalSpawnCount', dispatched.totalSpawnCount],
  ] } };
}

async function runningAgent(id, taskId, { pid = DEAD_PID, metadata = {} } = {}) {
  await registerAgent(id, taskId, { taskType: 'user', ...metadata });
  if (pid !== undefined) await updateAgent(id, { pid });
  return getAgentRecord(id);
}

beforeEach(() => {
  now = Math.max(now, Date.now()) + SWEEP_INTERVAL_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  runner.listed = [];
  sweeps.length = 0;
  completedEvents.length = 0;
  cosEvents.on('agent:completed', onCompleted);
  registerCosOrphanRecoveryHandlers({
    cleanupOrphanedAgents: () => {
      const sweep = cleanupOrphanedAgents();
      sweeps.push(sweep);
      return sweep;
    },
    handleOrphanedTask,
  });
});

afterEach(async () => {
  cosEvents.off('agent:completed', onCompleted);
  await Promise.allSettled(sweeps);
  vi.mocked(Date.now).mockRestore();
  for (const tracked of [activeAgents, runnerAgents, spawningTasks, completingAgents]) tracked.clear();
  registerCosOrphanRecoveryHandlers(null);
});

describe('GET /api/cos/agents retires a dead agent through the one reaper', () => {
  // The runner forgets an agent once it exits. An exit while the server was
  // down leaves its verdict in the agent directory and nothing else (#14261).
  it('finalizes a runner agent from its completion receipt instead of failing a run that succeeded', async () => {
    const receipt = await dispatchTask('task-receipt');
    const agent = await runningAgent('agent-receipt', 'task-receipt', { metadata: { ...receipt, useRunner: true, executionMode: 'runner' } });
    await mkdir(join(PATHS.cosAgents, agent.id), { recursive: true });
    await writeFile(join(PATHS.cosAgents, agent.id, 'metadata.json'), JSON.stringify({
      agentId: agent.id, taskId: 'task-receipt', exitCode: 0, success: true, duration: 4200,
      completedAt: new Date(Date.parse(agent.startedAt) + 4200).toISOString(),
    }));

    await listAgentsAndSettleItsSweep();

    const settled = await getAgentRecord(agent.id);
    expect(settled.status).toBe('completed');
    expect(settled.result).toMatchObject({ success: true, exitCode: 0, duration: 4200 });
    expect(settled.result.error).toBeUndefined();
    expect((await getTaskById('task-receipt')).status).toBe('completed');
    // A receipt is an exit, not a death: no orphan is recorded or charged.
    expect(appendRunEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'run.orphan-recovered' }));
    expect((await getTaskById('task-receipt')).metadata.orphanRetryCount).toBeUndefined();
    expect(completedEvents.map(event => event.id)).toEqual([agent.id]);

    // Later reads find nothing left to retire.
    await listAgentsAndSettleItsSweep();
    expect(completedEvents).toHaveLength(1);
  });

  // PortOS took these processes down itself. A marked run is requeued without
  // spending the task's orphan budget (#3202), whoever notices it first.
  it('retires a run named in the host-shutdown marker as interrupted, charging no orphan retry', async () => {
    const receipt = await dispatchTask('task-interrupted', { orphanRetryCount: 1, lastOrphanedAt: '2020-01-01T00:00:00.000Z', totalSpawnCount: 2 });
    const agent = await runningAgent('agent-interrupted', 'task-interrupted', { metadata: receipt });
    await writeHostShutdownMarker({ agentIds: [agent.id], signal: 'SIGTERM' });

    await listAgentsAndSettleItsSweep();

    const settled = await getAgentRecord(agent.id);
    expect(settled.status).toBe('completed');
    expect(settled.result).toMatchObject({
      success: false, orphaned: true, exitCode: 143, interruptedByRestart: true,
      error: 'Agent was interrupted by a PortOS server restart',
    });
    const task = await getTaskById('task-interrupted');
    expect(task.status).toBe('pending');
    expect(task.metadata).toMatchObject({ orphanRetryCount: 1, lastOrphanedAt: '2020-01-01T00:00:00.000Z', totalSpawnCount: 1, interruptedByRestart: true });
    expect(appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.orphan-recovered', agentId: agent.id, data: expect.objectContaining({ interruptedByRestart: true }),
    }));
    expect(existsSync(hostShutdownMarkerPath())).toBe(false);
    expect(completedEvents.map(event => event.id)).toEqual([agent.id]);
  });

  // Contrast for both cases above: with no receipt and no marker, the same dead
  // record IS an orphan, and its task pays for the retry.
  it('retires a dead run with neither receipt nor marker as an orphan and charges the retry', async () => {
    const receipt = await dispatchTask('task-orphan');
    const agent = await runningAgent('agent-orphan', 'task-orphan', { metadata: { ...receipt, useRunner: true, executionMode: 'runner' } });

    await listAgentsAndSettleItsSweep();

    const settled = await getAgentRecord(agent.id);
    expect(settled.result).toMatchObject({ success: false, orphaned: true, exitCode: 1, error: 'Agent process terminated unexpectedly' });
    const task = await getTaskById('task-orphan');
    expect(task.status).toBe('pending');
    expect(task.metadata.orphanRetryCount).toBe(1);
    expect(completedEvents.map(event => event.id)).toEqual([agent.id]);

    // The runner's own completion event, arriving after the fact, changes nothing.
    await handleAgentCompletion(agent.id, 0, true, 1000);
    expect((await getAgentRecord(agent.id)).result).toEqual(settled.result);
    expect(completedEvents).toHaveLength(1);
  });

  // The other order: the completion event is already being handled when the
  // list is read. Whichever finishes first, the run keeps the verdict it
  // reported and is finalized once.
  it('keeps the verdict of a completion that races the list read', async () => {
    const receipt = await dispatchTask('task-racing');
    const agent = await runningAgent('agent-racing', 'task-racing', { metadata: { ...receipt, useRunner: true, executionMode: 'runner' } });

    const completion = handleAgentCompletion(agent.id, 0, true, 1000);
    await listAgentsAndSettleItsSweep();
    await completion;
    await listAgentsAndSettleItsSweep();

    const settled = await getAgentRecord(agent.id);
    expect(settled.result).toMatchObject({ success: true, exitCode: 0 });
    expect((await getTaskById('task-racing')).status).toBe('completed');
    expect(appendRunEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'run.orphan-recovered' }));
    expect(completedEvents.map(event => event.id)).toEqual([agent.id]);
  });

  // Each of these has no pid the server can vouch for. What keeps the record
  // running is the one piece of evidence named, and nothing else: once it is
  // withdrawn, the next list read retires the same record.
  const runnerOwned = { useRunner: true, executionMode: 'runner' };
  describe.each([
    { evidence: 'a TUI the runner still holds, with no usable pid', pid: 0, metadata: { useRunner: true, executionMode: 'runner-tui' },
      hold: id => { runner.listed = [{ id, pid: 0, kind: 'tui', processActive: true, liveness: 'pty' }]; },
      withdraw: id => { runner.listed = [{ id, pid: 0, kind: 'tui', processActive: false, liveness: 'pty' }]; } },
    { evidence: 'a runner-owned agent while the runner cannot be asked', pid: DEAD_PID, metadata: runnerOwned,
      hold: () => { runner.listed = new Error('runner is restarting'); },
      withdraw: () => { runner.listed = []; } },
    { evidence: 'a direct agent whose handle this process holds', pid: DEAD_PID, metadata: {},
      hold: id => { activeAgents.set(id, {}); },
      withdraw: id => { activeAgents.delete(id); } },
    { evidence: 'a record whose task is still inside its spawn', pid: undefined, metadata: runnerOwned,
      hold: (_id, taskId) => { spawningTasks.add(taskId); },
      withdraw: (_id, taskId) => { spawningTasks.delete(taskId); } },
    { evidence: 'a run whose completion is being handled', pid: DEAD_PID, metadata: runnerOwned,
      hold: id => { completingAgents.add(id); },
      withdraw: id => { completingAgents.delete(id); } },
  ].map((held, index) => ({ ...held, taskId: `task-held-${index}`, agentId: `agent-held-${index}` })))('$evidence', ({ taskId, agentId, pid, metadata, hold, withdraw }) => {
    it('stays running through repeated list reads, and is retired once that evidence is gone', async () => {
      const receipt = await dispatchTask(taskId);
      const agent = await runningAgent(agentId, taskId, { pid, metadata: { ...receipt, ...metadata } });
      hold(agent.id, taskId);

      await listAgentsAndSettleItsSweep();
      const response = await listAgentsAndSettleItsSweep();

      expect(response.body.map(item => [item.id, item.status])).toContainEqual([agent.id, 'running']);
      expect((await getAgentRecord(agent.id)).status).toBe('running');
      expect((await getTaskById(taskId)).status).toBe('in_progress');
      expect(completedEvents).toEqual([]);

      withdraw(agent.id, taskId);
      // Past the no-pid spawn grace, for the record that never got one.
      now += 60_000;
      await listAgentsAndSettleItsSweep();

      expect((await getAgentRecord(agent.id)).status).toBe('completed');
      expect(completedEvents.map(event => event.id)).toEqual([agent.id]);
    });
  });

  it('leaves an agent whose pid answers running, however often the list is read', async () => {
    const receipt = await dispatchTask('task-live');
    const agent = await runningAgent('agent-live', 'task-live', { pid: process.pid, metadata: { ...receipt, ...runnerOwned } });

    await listAgentsAndSettleItsSweep();
    const response = await listAgentsAndSettleItsSweep();

    expect(response.body.map(item => [item.id, item.status])).toContainEqual([agent.id, 'running']);
    expect((await getAgentRecord(agent.id)).status).toBe('running');
    expect((await getTaskById('task-live')).status).toBe('in_progress');
    expect(completedEvents).toEqual([]);
  });
});
