import { describe, it, expect, vi } from 'vitest';
import {
  RUNNER_LIVENESS_PID,
  RUNNER_LIVENESS_PTY,
  usableAgentPid,
  runnerAgentLivenessFields,
  runnerListedAgentIsLive,
  runnerEntryShieldsRunningRecord,
} from './runnerAgentLiveness.js';

describe('usableAgentPid', () => {
  it('accepts a positive integer and rejects ConPTY / invalid pids', () => {
    expect(usableAgentPid(1234)).toBe(1234);
    expect(usableAgentPid('99')).toBe(99);
    expect(usableAgentPid(0)).toBeNull();
    expect(usableAgentPid(-1)).toBeNull();
    expect(usableAgentPid(null)).toBeNull();
    expect(usableAgentPid('nope')).toBeNull();
  });
});

describe('runnerAgentLivenessFields', () => {
  it('reports a TUI as live from onExit bookkeeping, not a pid-0 probe', () => {
    const fields = runnerAgentLivenessFields({ kind: 'tui', pid: 0, exited: false }, {
      active: false, state: 'invalid', cpu: 0, memoryMb: 0,
    });
    expect(fields).toEqual({
      processActive: true,
      state: 'running',
      cpu: 0,
      memoryMb: 0,
      liveness: RUNNER_LIVENESS_PTY,
    });
  });

  it('reports a TUI as dead once onExit has fired', () => {
    const fields = runnerAgentLivenessFields({ kind: 'tui', pid: 0, exited: true }, null);
    expect(fields.processActive).toBe(false);
    expect(fields.state).toBe('dead');
    expect(fields.liveness).toBe(RUNNER_LIVENESS_PTY);
  });

  it('keeps CPU/memory from a usable TUI pid while processActive follows onExit', () => {
    const fields = runnerAgentLivenessFields(
      { kind: 'tui', pid: 4321, exited: false },
      { active: true, state: 'S', cpu: 1.5, memoryMb: 12.3 },
    );
    expect(fields.processActive).toBe(true);
    expect(fields.state).toBe('S');
    expect(fields.cpu).toBe(1.5);
    expect(fields.memoryMb).toBe(12.3);
    expect(fields.liveness).toBe(RUNNER_LIVENESS_PTY);
  });

  it('treats a CLI row as a pid probe', () => {
    const live = runnerAgentLivenessFields(
      { kind: 'cli', pid: 7 },
      { active: true, state: 'R', cpu: 2, memoryMb: 8 },
    );
    expect(live).toMatchObject({
      processActive: true, state: 'R', liveness: RUNNER_LIVENESS_PID,
    });
    const dead = runnerAgentLivenessFields(
      { pid: 7 },
      { active: false, state: 'dead', cpu: 0, memoryMb: 0 },
    );
    expect(dead).toMatchObject({
      processActive: false, state: 'dead', liveness: RUNNER_LIVENESS_PID,
    });
  });
});

describe('runnerListedAgentIsLive', () => {
  it('trusts processActive when the runner tagged how it measured', () => {
    expect(runnerListedAgentIsLive({
      processActive: true, liveness: RUNNER_LIVENESS_PTY, kind: 'tui',
    })).toBe(true);
    expect(runnerListedAgentIsLive({
      processActive: false, liveness: RUNNER_LIVENESS_PTY, kind: 'tui',
    })).toBe(false);
    expect(runnerListedAgentIsLive({
      processActive: false, liveness: RUNNER_LIVENESS_PID, kind: 'cli',
    })).toBe(false);
  });

  it('does not treat a pre-fix Windows TUI processActive false as dead', () => {
    expect(runnerListedAgentIsLive({
      kind: 'tui', pid: 0, processActive: false,
    })).toBe(true);
  });

  it('does not treat a pre-fix POSIX TUI with a dead pid as live', () => {
    expect(runnerListedAgentIsLive({
      kind: 'tui', pid: 4242, processActive: false,
    })).toBe(false);
  });

  it('does not treat a bare CLI listing as live', () => {
    expect(runnerListedAgentIsLive({ id: 'agent-1', kind: 'cli', pid: 9 })).toBe(false);
    expect(runnerListedAgentIsLive({
      kind: 'cli', pid: 9, processActive: false,
    })).toBe(false);
  });
});

describe('runnerEntryShieldsRunningRecord', () => {
  const pidIsAlive = vi.fn();

  it('shields a live TUI from onExit bookkeeping without probing pid 0', async () => {
    pidIsAlive.mockResolvedValue(false);
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'tui', pid: 0, processActive: true, liveness: RUNNER_LIVENESS_PTY,
    }, pidIsAlive)).resolves.toBe(true);
    expect(pidIsAlive).not.toHaveBeenCalled();
  });

  it('does not shield a TUI whose onExit bookkeeping says the process is gone', async () => {
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'tui', pid: 0, processActive: false, liveness: RUNNER_LIVENESS_PTY,
    }, pidIsAlive)).resolves.toBe(false);
  });

  it('does not shield a CLI listing whose pid probe says dead', async () => {
    pidIsAlive.mockResolvedValue(false);
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'cli', pid: 4242, processActive: false, liveness: RUNNER_LIVENESS_PID,
    }, pidIsAlive)).resolves.toBe(false);
  });

  it('still shields a CLI whose processActive flaked but the pid is alive', async () => {
    pidIsAlive.mockResolvedValue(true);
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'cli', pid: 4242, processActive: false, liveness: RUNNER_LIVENESS_PID,
    }, pidIsAlive)).resolves.toBe(true);
  });

  it('shields a pre-fix Windows TUI listed with a pid-0 artifact', async () => {
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'tui', pid: 0, processActive: false,
    }, pidIsAlive)).resolves.toBe(true);
  });

  it('does not shield a pre-fix POSIX TUI listing unless the pid is still alive', async () => {
    pidIsAlive.mockResolvedValue(false);
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'tui', pid: 4242, processActive: false,
    }, pidIsAlive)).resolves.toBe(false);
    pidIsAlive.mockResolvedValue(true);
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'tui', pid: 4242, processActive: false,
    }, pidIsAlive)).resolves.toBe(true);
  });

  it('does not shield a pre-fix CLI listing unless the pid is still alive', async () => {
    pidIsAlive.mockResolvedValue(false);
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'cli', pid: 4242, processActive: false,
    }, pidIsAlive)).resolves.toBe(false);
    pidIsAlive.mockResolvedValue(true);
    await expect(runnerEntryShieldsRunningRecord({
      kind: 'cli', pid: 4242, processActive: false,
    }, pidIsAlive)).resolves.toBe(true);
  });
});
