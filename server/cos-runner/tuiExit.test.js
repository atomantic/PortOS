import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/bufferedSpawn.js', () => ({ killProcessTree: vi.fn() }));

import { armForceKill } from './forceKill.js';
import { createTuiExitHandler } from './tuiExit.js';

function setup(extra = {}) {
  const agent = {
    process: {}, startedAt: Date.now(), outputBuffer: 'Usage limit reached',
    completedBySentinel: false, exited: false, doneWatcher: vi.fn(), ...extra,
  };
  const activeAgents = new Map([['agent-old', agent]]);
  const state = { agents: { 'agent-old': { status: 'paused' } }, stats: { completed: 0, failed: 0 } };
  const io = { emit: vi.fn() };
  const emitToServer = vi.fn();
  const withState = vi.fn(async fn => fn(state));
  const onExit = createTuiExitHandler({
    agentId: 'agent-old', taskId: 'task-1', sessionId: 'session-1',
    agent, activeAgents, io, emitToServer, withState,
  });
  return { agent, activeAgents, state, io, emitToServer, withState, onExit };
}

afterEach(() => vi.useRealTimers());

describe('runner TUI exit handoff', () => {
  it('delivers the exit after force-kill removed the handle, exactly once', async () => {
    vi.useFakeTimers();
    const run = setup();
    armForceKill(run.activeAgents, 'agent-old', run.agent, { graceMs: 5000 });
    vi.advanceTimersByTime(5000);
    expect(run.activeAgents.size).toBe(0);
    // Sending SIGKILL alone must not release the server's worktree hold.
    expect(run.io.emit).not.toHaveBeenCalled();

    await run.onExit({ exitCode: 0, signal: 9 });
    await run.onExit({ exitCode: 0, signal: 9 });
    expect(run.io.emit).toHaveBeenCalledExactlyOnceWith('tui:exit', {
      agentId: 'agent-old', sessionId: 'session-1', exitCode: 0, signal: 9,
      outputTail: 'Usage limit reached',
    });
    expect(run.emitToServer).toHaveBeenCalledTimes(1);
    expect(run.state.stats).toEqual({ completed: 1, failed: 1 });
    expect(run.agent.doneWatcher).toHaveBeenCalledTimes(1);
  });

  it('releases the transport on paused exit while preserving the resumable record', async () => {
    const run = setup({ paused: true });
    await run.onExit({ exitCode: 0, signal: 15 });
    expect(run.io.emit).toHaveBeenCalledWith('tui:exit', expect.objectContaining({ signal: 15 }));
    expect(run.activeAgents.size).toBe(0);
    expect(run.emitToServer).not.toHaveBeenCalled();
    expect(run.withState).not.toHaveBeenCalled();
    expect(run.state.agents['agent-old']).toEqual({ status: 'paused' });
  });

  it('retains successful sentinel completion and bounds the exit transcript', async () => {
    const run = setup({ completedBySentinel: true, outputBuffer: 'x'.repeat(20000) });
    await run.onExit({ exitCode: 1, signal: 15 });
    expect(run.io.emit).toHaveBeenCalledWith('tui:exit', expect.objectContaining({
      exitCode: 0, signal: 0, outputTail: 'x'.repeat(16 * 1024),
    }));
    expect(run.state.stats).toEqual({ completed: 1, failed: 0 });
    expect(run.state.agents).toEqual({});
  });
});
