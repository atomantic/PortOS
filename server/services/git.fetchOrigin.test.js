import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const execGitMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/execGit.js', () => ({
  execGit: execGitMock
}));

import { fetchOrigin } from './git.js';

describe('fetchOrigin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execGitMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries when another fetch advances the remote ref first', async () => {
    execGitMock
      .mockRejectedValueOnce(new Error("error: cannot lock ref 'refs/remotes/origin/main': is at aaaaaaa but expected bbbbbbb"))
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = fetchOrigin('/repo');
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBe(true);
    expect(execGitMock).toHaveBeenCalledTimes(2);
    expect(execGitMock).toHaveBeenNthCalledWith(1, ['fetch', 'origin'], '/repo');
    expect(execGitMock).toHaveBeenNthCalledWith(2, ['fetch', 'origin'], '/repo');
  });

  it('does not retry a permanent fetch failure', async () => {
    execGitMock.mockRejectedValueOnce(new Error('fatal: repository not found'));

    await expect(fetchOrigin('/repo')).rejects.toThrow(/repository not found/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the lock error after the retry budget is exhausted', async () => {
    execGitMock.mockRejectedValue(new Error('error: cannot lock ref'));

    const result = fetchOrigin('/repo');
    const assertion = expect(result).rejects.toThrow(/cannot lock ref/);
    await vi.runAllTimersAsync();

    await assertion;
    expect(execGitMock).toHaveBeenCalledTimes(4);
  });
});
