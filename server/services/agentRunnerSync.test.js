import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

// The completion-receipt reader reads PATHS.cosAgents; keep it off the live install.
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-runner-receipt-') });
});

const recoveredPty = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('./cos.js', () => ({}));
vi.mock('./cosRunnerClient.js', () => ({
  getActiveAgentsFromRunner: vi.fn(),
  terminateAgentViaRunner: vi.fn(async () => ({ success: true, terminated: true })),
  connectTuiSessionViaRunner: vi.fn(() => ({
    sessionId: 'tui-session-1',
    pid: 1234,
    ptyProcess: recoveredPty,
  })),
}));

vi.mock('./shell.js', () => ({
  getSession: vi.fn(),
  registerExternalSession: vi.fn(),
  unregisterExternalSession: vi.fn(),
}));

vi.mock('./cosTaskStore.js', () => ({
  getAllTasks: vi.fn().mockResolvedValue({
    user: { grouped: { active: [{ id: 'task-1', description: 'Example task' }] } },
    cos: { grouped: {} },
  }),
}));

// Stub ONLY the read. `isLiveAgentRecord` is the contract this guard turns on,
// so it comes from the real module — a re-implemented copy here would keep
// passing if the real predicate changed (e.g. started treating `paused` as
// terminal) while production behavior flipped underneath it.
vi.mock('./cosAgentLifecycle.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readAgentRecordOrUnreadable: vi.fn(),
}));

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl) —
// mocked so recovery telemetry lands in a spy rather than the developing
// install's ledger, and so the boundary assertion below can read the envelope.
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));

import { connectTuiSessionViaRunner, getActiveAgentsFromRunner, terminateAgentViaRunner } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import { AGENT_RECORD_UNREADABLE, readAgentRecordOrUnreadable } from './cosAgentLifecycle.js';
import { activeAgents, runnerAgents, spawningTasks } from './agentState.js';
import { readRunnerCompletionReceipt, syncRunnerAgents } from './agentRunnerSync.js';
import { PATHS } from '../lib/fileUtils.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

afterAll(cleanupTempDataRoots);

describe('syncRunnerAgents runner-owned TUI recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
    activeAgents.clear();
    spawningTasks.clear();
    vi.mocked(shellService.getSession).mockReturnValue(null);
    vi.mocked(readAgentRecordOrUnreadable).mockResolvedValue({ id: 'agent-1', status: 'running' });
  });

  it('reconciles one surviving TUI and restores its attachable shell relay', async () => {
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-1',
      taskId: 'task-1',
      pid: 1234,
      startedAt: Date.now(),
      kind: 'tui',
      processActive: true,
      liveness: 'pty',
      sessionId: 'tui-session-1',
      command: 'codex',
      workspacePath: '/tmp/example-workspace',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(runnerAgents.has('agent-1')).toBe(true);
    expect(connectTuiSessionViaRunner).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'tui-session-1',
      pid: 1234,
    }));
    expect(shellService.registerExternalSession).toHaveBeenCalledWith(
      'tui-session-1',
      recoveredPty,
      expect.objectContaining({
        agentId: 'agent-1',
        kind: 'agent-tui',
        command: 'codex',
      }),
    );
  });

  // #3244. The runner's /agents response describes the live process and carries
  // no `metadata`, so the run id has to come off the persisted agent record.
  // Dropping it left the survivor's run open forever and unbilled, because
  // `completeAgentRun` returns early on a null id — and survivors are the normal
  // case since #3202 made TUI agents durable.
  it('recovers the run id and model from the persisted agent record', async () => {
    vi.mocked(readAgentRecordOrUnreadable).mockResolvedValue({
      id: 'agent-1',
      status: 'running',
      metadata: { runId: 'run-abc123', model: 'claude-opus-5' },
    });
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-1', taskId: 'task-1', pid: 1234, startedAt: Date.now(),
      kind: 'cli', processActive: true, liveness: 'pid',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(readAgentRecordOrUnreadable).toHaveBeenCalledWith('agent-1');
    expect(runnerAgents.get('agent-1')).toMatchObject({
      runId: 'run-abc123',
      model: 'claude-opus-5',
    });
  });

  it('recovers with a null run id rather than throwing when the record is unreadable', async () => {
    // A record that cannot be READ must not take the whole recovery sweep down
    // with it, and must not be mistaken for one that is absent: the read proves
    // nothing, and the surviving agent still needs re-adopting so its completion
    // event lands. The run stays open, which the warning line says out loud.
    vi.mocked(readAgentRecordOrUnreadable).mockResolvedValue(AGENT_RECORD_UNREADABLE);
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-2', taskId: 'task-1', pid: 99, startedAt: Date.now(),
      kind: 'cli', processActive: true, liveness: 'pid',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(1);
    expect(runnerAgents.get('agent-2')).toMatchObject({ runId: null });
    // Today the unbilled-run warning exists only as a console line nothing
    // retains; the ledger is what makes it answerable after the fact (#4540).
    expect(appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.runner-recovered',
      agentId: 'agent-2',
      runId: null,
      data: expect.objectContaining({ hasRunId: false })
    }));
  });

  // The runner goes on advertising a PTY it failed to kill. Adopting one mints a
  // phantom runnerAgents entry nothing ever removes — which is what pinned the
  // Update page on "4 CoS agents are currently running" above an empty agent
  // list, since the durable records those four were finalized in are long gone.
  it('ignores a runner agent PortOS has already finalized, and one with no record at all', async () => {
    vi.mocked(readAgentRecordOrUnreadable).mockImplementation(async (id) => {
      if (id === 'agent-finalized') return { id, status: 'completed' };
      if (id === 'agent-gone') return null;
      return { id, status: 'running' };
    });
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([
      { id: 'agent-finalized', taskId: 'task-1', pid: 1, startedAt: Date.now(), kind: 'cli', processActive: true, liveness: 'pid' },
      { id: 'agent-gone', taskId: 'task-1', pid: 2, startedAt: Date.now(), kind: 'cli', processActive: true, liveness: 'pid' },
      { id: 'agent-real', taskId: 'task-1', pid: 3, startedAt: Date.now(), kind: 'cli', processActive: true, liveness: 'pid' },
    ]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(runnerAgents.has('agent-finalized')).toBe(false);
    expect(runnerAgents.has('agent-gone')).toBe(false);
    expect(runnerAgents.has('agent-real')).toBe(true);
  });

  // A live runner-TUI is owned by this process's spawnTuiAgent closure, which
  // registers in `activeAgents` — never in `runnerAgents`. Hoisting it here made
  // subAgentSpawner's `agent:completed` handler run a second finalizeAgent over
  // the TUI's own sentinel-signalled success, flipping the agent card to failed.
  // `cleanupOrphanedAgents` calls this every 15 minutes, so every TUI run longer
  // than one tick was exposed. The unowned agent in the same sweep pins that this
  // skips one entry rather than abandoning the loop.
  it('skips a TUI this process already owns while still adopting real survivors', async () => {
    activeAgents.set('agent-live', { task: { id: 'task-1' }, startedAt: Date.now() });
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([
      {
        id: 'agent-live',
        taskId: 'task-1',
        pid: 4321,
        startedAt: Date.now(),
        kind: 'tui',
        processActive: true,
        liveness: 'pty',
        sessionId: 'tui-session-live',
        command: 'claude',
        workspacePath: '/tmp/example-workspace',
      },
      { id: 'agent-orphan', taskId: 'task-1', pid: 8765, startedAt: Date.now(), kind: 'cli', processActive: true, liveness: 'pid' },
    ]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(runnerAgents.has('agent-live')).toBe(false);
    expect(runnerAgents.has('agent-orphan')).toBe(true);
    // The owned TUI's shell relay is already registered by its spawner;
    // re-attaching would hand the same PTY two readers.
    expect(connectTuiSessionViaRunner).not.toHaveBeenCalled();
    expect(shellService.registerExternalSession).not.toHaveBeenCalled();
  });

  it('does not re-adopt a stale runner handle whose process is gone', async () => {
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-stale',
      taskId: 'task-1',
      pid: 2147483646,
      startedAt: Date.now(),
      kind: 'cli',
      processActive: false,
      liveness: 'pid',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(0);
    expect(runnerAgents.has('agent-stale')).toBe(false);
  });
});

describe('syncRunnerAgents — reconnect boundary (#4540)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
    activeAgents.clear();
    spawningTasks.clear();
    vi.mocked(shellService.getSession).mockReturnValue(null);
    vi.mocked(readAgentRecordOrUnreadable).mockResolvedValue({ status: 'running', metadata: { runId: 'run-abc123' } });
  });

  const survivingTui = {
    id: 'agent-1', taskId: 'task-1', pid: 42, startedAt: Date.now(),
    kind: 'tui', processActive: true, liveness: 'pty',
    sessionId: 'tui-session-1', workspacePath: '/repo/worktree', command: 'claude',
  };

  it('records the PTY re-attach separately from the run re-adoption', async () => {
    // Two different things can fail on a restart: re-adopting the RUN and
    // re-plumbing its terminal stream. One event for both would make a run whose
    // stream never came back read as fully recovered.
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([survivingTui]);

    await syncRunnerAgents();

    const kinds = appendRunEvent.mock.calls.map(([e]) => e.kind);
    expect(kinds).toEqual(['run.runner-recovered', 'run.reconnected']);
    expect(appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.reconnected',
      runId: 'run-abc123',
      agentId: 'agent-1',
      taskId: 'task-1',
      data: expect.objectContaining({ transport: 'runner-pty', sessionId: 'tui-session-1' })
    }));
  });

  it('records no reconnect when the stream was already attached', async () => {
    vi.mocked(shellService.getSession).mockReturnValue({ sessionId: 'tui-session-1' });
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([survivingTui]);

    await syncRunnerAgents();

    expect(appendRunEvent.mock.calls.map(([e]) => e.kind)).toEqual(['run.runner-recovered']);
  });

  // A server restart loses the controller's paste/Enter timers, while the
  // runner keeps the empty composer alive. Recovery must await real exit and
  // use ordinary completion/retry, rather than replaying a possibly pasted task.
  it('stops an unsubmitted startup only after registering its completion owner and relay', async () => {
    getActiveAgentsFromRunner.mockResolvedValue([{ ...survivingTui, promptSubmitted: false }]);
    terminateAgentViaRunner.mockImplementationOnce(async () => {
      expect(runnerAgents.get('agent-1')).toMatchObject({
        startupErrorAnalysis: { category: 'startup-failure', actionable: false },
      });
      expect(shellService.registerExternalSession).toHaveBeenCalled();
      expect(recoveredPty.onExit).toHaveBeenCalled();
      return { success: true, terminated: true };
    });

    await expect(syncRunnerAgents()).resolves.toBe(1);
    expect(terminateAgentViaRunner).toHaveBeenCalledWith('agent-1', { onlyIfPromptUnsubmitted: true });
    expect(runnerAgents.has('agent-1')).toBe(true);
    expect(recoveredPty.write).not.toHaveBeenCalled();
  });

  it.each([true, null, undefined])('preserves a submitted or legacy TUI (receipt=%s)', async promptSubmitted => {
    getActiveAgentsFromRunner.mockResolvedValue([{ ...survivingTui, promptSubmitted }]);
    await syncRunnerAgents();
    expect(terminateAgentViaRunner).not.toHaveBeenCalled();
    expect(runnerAgents.get('agent-1').startupErrorAnalysis).toBeUndefined();
  });

  it('preserves a task submitted after the recovery listing, using the runner refusal', async () => {
    getActiveAgentsFromRunner.mockResolvedValue([{ ...survivingTui, promptSubmitted: false }]);
    terminateAgentViaRunner.mockResolvedValueOnce({ success: true, terminated: false });
    await syncRunnerAgents();
    expect(runnerAgents.get('agent-1').startupErrorAnalysis).toBeUndefined();
    await syncRunnerAgents();
    expect(terminateAgentViaRunner).toHaveBeenCalledTimes(1);
  });

  it('retains ownership and retries a failed startup stop on the next sweep', async () => {
    getActiveAgentsFromRunner.mockResolvedValue([{ ...survivingTui, promptSubmitted: false }]);
    terminateAgentViaRunner.mockRejectedValueOnce(new Error('runner connection reset'));
    await syncRunnerAgents();
    expect(runnerAgents.has('agent-1')).toBe(true);
    await syncRunnerAgents();
    expect(terminateAgentViaRunner).toHaveBeenCalledTimes(2);
    expect(shellService.registerExternalSession).toHaveBeenCalledTimes(1);
  });

  it('leaves a late-acknowledged spawn with its live controller on reconnect', async () => {
    spawningTasks.add(survivingTui.taskId);
    getActiveAgentsFromRunner.mockResolvedValue([{ ...survivingTui, promptSubmitted: false }]);
    await expect(syncRunnerAgents()).resolves.toBe(0);
    expect(runnerAgents.has('agent-1')).toBe(false);
    expect(terminateAgentViaRunner).not.toHaveBeenCalled();
    expect(shellService.registerExternalSession).not.toHaveBeenCalled();
  });
});

// The runner writes this receipt before its fire-and-forget `agent:completed`;
// the orphan sweep trusts it only when it proves a completion of THIS run (#14261).
describe('readRunnerCompletionReceipt', () => {
  const record = { taskId: 'task-1', startedAt: '2026-01-01T00:00:01.000Z' };
  const receipt = { agentId: 'agent-r', taskId: 'task-1', completedAt: '2026-01-01T00:05:00.000Z', exitCode: 0, success: true, duration: 299000 };
  const writeReceipt = async (agentId, content) => {
    await mkdir(join(PATHS.cosAgents, agentId), { recursive: true });
    await writeFile(join(PATHS.cosAgents, agentId, 'metadata.json'), typeof content === 'string' ? content : JSON.stringify(content));
  };

  it.each([
    ['success', receipt, { exitCode: 0, success: true, duration: 299000 }],
    ['failure', { ...receipt, exitCode: 2, success: false }, { exitCode: 2, success: false, duration: 299000 }],
    ['no duration', { ...receipt, duration: undefined }, { exitCode: 0, success: true, duration: 299000 }],
  ])('returns the verdict of a %s receipt', async (name, content, expected) => {
    await writeReceipt(`agent-${name.replace(/ /g, '-')}`, content);
    await expect(readRunnerCompletionReceipt(`agent-${name.replace(/ /g, '-')}`, record)).resolves.toEqual(expected);
  });

  it.each([
    ['corrupt', '{not json'],
    ['paused (no verdict)', { agentId: 'agent-r', outputSize: 10 }],
    ['another task', { ...receipt, taskId: 'task-2' }],
    ['an earlier run', { ...receipt, completedAt: '2025-12-31T23:59:59.000Z' }],
    ['a string exit code', { ...receipt, exitCode: '0' }],
  ])('rejects a receipt from %s', async (name, content) => {
    const agentId = `agent-bad-${name.replace(/\W+/g, '-')}`;
    await writeReceipt(agentId, content);
    await expect(readRunnerCompletionReceipt(agentId, record)).resolves.toBeNull();
  });

  it('returns null when no receipt exists', async () => {
    await expect(readRunnerCompletionReceipt('agent-missing', record)).resolves.toBeNull();
  });
});
