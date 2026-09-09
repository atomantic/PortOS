import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const execGitMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/execGit.js', () => ({
  execGit: execGitMock,
  execGitSafe: (...args) => execGitMock(...args).catch(err => ({ exitCode: 1, stdout: '', stderr: err.message }))
}));

import { getRemoteBranches, fetchOrigin, clearFetchCache, isFetchFresh } from './git.js';

describe('fetchOrigin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execGitMock.mockReset();
    clearFetchCache();
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

  it('accepts a lost compare-and-swap without a second fetch', async () => {
    // The concurrent winner already wrote origin/main to the very commit this
    // fetch wanted, so the refs are correct and there is nothing left to do.
    execGitMock.mockRejectedValueOnce(new Error([
      "error: cannot lock ref 'refs/remotes/origin/main': is at f485411c6fcc274d9c298f0476ef91990748ad0a but expected f538668661cc298c15abeb6cf78e886b71eae623",
      'From github.com:example/example',
      ' ! f538668..f485411  main       -> origin/main  (unable to update local ref)'
    ].join('\n')));

    await expect(fetchOrigin('/repo')).resolves.toBe(true);
    expect(execGitMock).toHaveBeenCalledTimes(1);
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

describe('getRemoteBranches fetch freshness window & deduplication', () => {
  beforeEach(() => {
    execGitMock.mockReset();
    clearFetchCache();
  });

  it('skips fetch when getRemoteBranches is called again inside freshness window', async () => {
    // Return success for fetch and standard mock outputs for git branch commands
    execGitMock.mockResolvedValue({ stdout: 'origin/main|2026-08-19|author\n', stderr: '', exitCode: 0 });

    await getRemoteBranches('/repo-fresh');
    const callsFirst = execGitMock.mock.calls.filter(c => c[0][0] === 'fetch');
    expect(callsFirst).toHaveLength(1);
    expect(isFetchFresh('/repo-fresh')).toBe(true);

    // Second call immediately within window
    await getRemoteBranches('/repo-fresh');
    const callsSecond = execGitMock.mock.calls.filter(c => c[0][0] === 'fetch');
    expect(callsSecond).toHaveLength(1); // No new fetch calls
  });

  it('deduplicates concurrent calls to getRemoteBranches for the same repo', async () => {
    let resolveFetch;
    const fetchPromise = new Promise(r => { resolveFetch = r; });

    execGitMock.mockImplementation((args) => {
      if (args[0] === 'fetch') {
        return fetchPromise.then(() => ({ stdout: '', stderr: '', exitCode: 0 }));
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // Launch two calls concurrently
    const p1 = getRemoteBranches('/repo-concurrent');
    const p2 = getRemoteBranches('/repo-concurrent');

    resolveFetch();
    await Promise.all([p1, p2]);

    const fetchCalls = execGitMock.mock.calls.filter(c => c[0][0] === 'fetch');
    expect(fetchCalls).toHaveLength(1);
  });

  it('fetchOrigin runs unconditionally and updates freshness for getRemoteBranches', async () => {
    execGitMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await fetchOrigin('/repo-update');
    expect(isFetchFresh('/repo-update')).toBe(true);

    // Subsequent getRemoteBranches call skips fetch because fetchOrigin refreshed it
    await getRemoteBranches('/repo-update');
    const fetchCalls = execGitMock.mock.calls.filter(c => c[0][0] === 'fetch');
    // 1 from fetchOrigin, 0 from getRemoteBranches
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0][0]).toEqual(['fetch', 'origin']);
  });

  it('bypasses freshness window when getRemoteBranches is called with force option', async () => {
    execGitMock.mockResolvedValue({ stdout: 'origin/main|2026-08-19|author\n', stderr: '', exitCode: 0 });

    await getRemoteBranches('/repo-forced');
    const callsFirst = execGitMock.mock.calls.filter(c => c[0][0] === 'fetch');
    expect(callsFirst).toHaveLength(1);

    // Second call with force = true
    await getRemoteBranches('/repo-forced', { force: true });
    const callsSecond = execGitMock.mock.calls.filter(c => c[0][0] === 'fetch');
    expect(callsSecond).toHaveLength(2);
  });
});
