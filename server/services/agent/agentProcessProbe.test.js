import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinPlatform } from '../../lib/testHelper.js';
import { getAgentProcessStats, isPidAlive } from './agentProcessProbe.js';

const mocks = vi.hoisted(() => ({
  activeAgents: new Map(),
  runnerAgents: new Set(),
  useRunner: false,
  exec: vi.fn(),
  runnerStats: vi.fn(),
}));

vi.mock('./agentState.js', () => ({
  activeAgents: mocks.activeAgents,
  runnerAgents: mocks.runnerAgents,
  get useRunner() { return mocks.useRunner; },
}));
vi.mock('../../lib/childProcess.js', () => ({ exec: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) }));
vi.mock('../cos/cosRunnerClient.js', () => ({ getAgentStatsFromRunner: mocks.runnerStats }));

beforeEach(() => {
  mocks.activeAgents.clear();
  mocks.runnerAgents.clear();
  mocks.useRunner = false;
  mocks.exec.mockReset();
  mocks.runnerStats.mockReset();
});

let restorePlatform;

afterEach(() => {
  restorePlatform?.();
  restorePlatform = undefined;
  vi.restoreAllMocks();
});

describe('getAgentProcessStats', () => {
  const agentId = 'fixture-agent';
  const pid = 4321;
  const respond = (platform, stdout) => {
    restorePlatform = pinPlatform(platform);
    mocks.activeAgents.set(agentId, { pid });
    mocks.exec.mockResolvedValue({ stdout });
  };

  it('reads POSIX CPU, RSS and state from ps', async () => {
    respond('darwin', '  4321  12.5  2048  S+\n');

    expect(await getAgentProcessStats(agentId)).toEqual({
      active: true, agentId, pid, cpu: 12.5, memoryKb: 2048, memoryMb: 2, state: 'S+',
    });
    expect(mocks.exec).toHaveBeenCalledWith('ps -p 4321 -o pid=,pcpu=,rss=,state=');
  });

  it('parses tasklist CSV when the image name and memory fields contain commas', async () => {
    respond('win32', '"Worker, Inc.exe","4321","Console","1","82,156 K"\r\n');

    expect(await getAgentProcessStats(agentId)).toEqual({
      active: true, agentId, pid, cpu: 0, memoryKb: 82156, memoryMb: 80.2, state: 'running',
    });
    expect(mocks.exec).toHaveBeenCalledWith('tasklist /FI "PID eq 4321" /FO CSV /NH');
  });

  it('keeps an attaching TUI with a null PID active without probing the host', async () => {
    mocks.activeAgents.set(agentId, { pid: null });

    expect(await getAgentProcessStats(agentId)).toEqual({
      active: true, agentId, pid: null, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown',
    });
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.runnerStats).not.toHaveBeenCalled();
  });

  it('returns dead when the process probe fails', async () => {
    respond('darwin', '');
    mocks.exec.mockRejectedValue(new Error('process exited'));

    expect(await getAgentProcessStats(agentId)).toEqual({
      active: false, pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'dead',
    });
  });

  it.each([
    { knownToRunner: true, useRunner: false },
    { knownToRunner: false, useRunner: true },
  ])('delegates an absent local agent with runner state %j', async ({ knownToRunner, useRunner }) => {
    if (knownToRunner) mocks.runnerAgents.add(agentId);
    mocks.useRunner = useRunner;
    const stats = { active: true, agentId, pid, cpu: 3 };
    mocks.runnerStats.mockResolvedValue(stats);

    expect(await getAgentProcessStats(agentId)).toEqual(stats);
    expect(mocks.runnerStats).toHaveBeenCalledWith(agentId);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('returns null for an unknown agent with runner mode disabled', async () => {
    expect(await getAgentProcessStats(agentId)).toBeNull();
    expect(mocks.runnerStats).not.toHaveBeenCalled();
  });
});

describe('isPidAlive', () => {
  it('returns false for an absent PID and uses signal zero to check a known PID', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValueOnce(true).mockImplementationOnce(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    expect(await isPidAlive(null)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(await isPidAlive(4321)).toBe(true);
    expect(await isPidAlive(4321)).toBe(false);
    expect(kill.mock.calls).toEqual([[4321, 0], [4321, 0]]);
  });
});
