import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveredPty = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('./cosRunnerClient.js', () => ({
  getActiveAgentsFromRunner: vi.fn(),
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

vi.mock('./cos.js', () => ({
  getAllTasks: vi.fn().mockResolvedValue({
    user: { grouped: { active: [{ id: 'task-1', description: 'Example task' }] } },
    cos: { grouped: {} },
  }),
}));

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(),
}));

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl) —
// mocked so recovery telemetry lands in a spy rather than the developing
// install's ledger, and so the boundary assertion below can read the envelope.
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));

import { connectTuiSessionViaRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import { getAgent } from './cosAgentLifecycle.js';
import { activeAgents, runnerAgents } from './agentState.js';
import { syncRunnerAgents } from './agentRunnerSync.js';

describe('syncRunnerAgents runner-owned TUI recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
    activeAgents.clear();
    vi.mocked(shellService.getSession).mockReturnValue(null);
    vi.mocked(getAgent).mockResolvedValue(null);
  });

  it('reconciles one surviving TUI and restores its attachable shell relay', async () => {
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-1',
      taskId: 'task-1',
      pid: 1234,
      startedAt: Date.now(),
      kind: 'tui',
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
    vi.mocked(getAgent).mockResolvedValue({
      id: 'agent-1',
      metadata: { runId: 'run-abc123', model: 'claude-opus-5' },
    });
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-1', taskId: 'task-1', pid: 1234, startedAt: Date.now(), kind: 'cli',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(getAgent).toHaveBeenCalledWith('agent-1');
    expect(runnerAgents.get('agent-1')).toMatchObject({
      runId: 'run-abc123',
      model: 'claude-opus-5',
    });
  });

  it('recovers with a null run id rather than throwing when the record is gone', async () => {
    // A record that cannot be read must not take the whole recovery sweep down
    // with it — the surviving agent still needs re-adopting so its completion
    // event lands. The run stays open, which the warning line says out loud.
    vi.mocked(getAgent).mockRejectedValue(new Error('metadata.json unreadable'));
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-2', taskId: 'task-1', pid: 99, startedAt: Date.now(), kind: 'cli',
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
        sessionId: 'tui-session-live',
        command: 'claude',
        workspacePath: '/tmp/example-workspace',
      },
      { id: 'agent-orphan', taskId: 'task-1', pid: 8765, startedAt: Date.now(), kind: 'cli' },
    ]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(runnerAgents.has('agent-live')).toBe(false);
    expect(runnerAgents.has('agent-orphan')).toBe(true);
    // The owned TUI's shell relay is already registered by its spawner;
    // re-attaching would hand the same PTY two readers.
    expect(connectTuiSessionViaRunner).not.toHaveBeenCalled();
    expect(shellService.registerExternalSession).not.toHaveBeenCalled();
  });
});
