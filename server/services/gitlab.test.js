/**
 * `findMergeRequestForBranch` — the GitLab mirror of the GitHub PR lookup the
 * agent PR-claim verification uses (#3358). Same three-state contract: asking
 * and getting nothing must never be confused with not being able to ask.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('../lib/childProcess.js', () => ({ spawn: (...args) => spawnMock(...args) }));

const { findMergeRequestForBranch } = await import('./gitlab.js');

/** A fake `glab` child that writes `stdout` then exits with `code`. */
const glabChild = ({ code = 0, stdout = '' } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
};

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => glabChild({ code: 0, stdout: '[]' }));
});

describe('findMergeRequestForBranch (#3358)', () => {
  it('reports `found` with the MR iid', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({
      stdout: '[{"iid":12,"web_url":"https://gitlab.example/g/p/-/merge_requests/12","state":"opened"}]'
    }));
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'found', number: 12 });
  });

  it('queries by source branch across every state', async () => {
    await findMergeRequestForBranch('claim/issue-1', '/repo');
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toEqual(['mr', 'list', '--source-branch', 'claim/issue-1', '--all', '-P', '1', '-F', 'json']);
    expect(opts.cwd).toBe('/repo');
  });

  it('reports `none` for an ANSWERED empty list', async () => {
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'none', number: null });
  });

  it('reports `unavailable` — never `none` — when glab fails', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({ code: 1 }));
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports `unavailable` when a zero-exit glab emits unparseable output', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({ stdout: 'not json' }));
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'unavailable' });
  });

  it('never spawns without a branch or a repo path', async () => {
    await expect(findMergeRequestForBranch('', '/repo')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(findMergeRequestForBranch('b', '')).resolves.toMatchObject({ status: 'unavailable' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('execGlab timeout (#3358)', () => {
  it('kills a stalled glab and resolves null instead of hanging the caller', async () => {
    // Without this bound, the agent PR-claim verification that awaits an MR
    // lookup would strand a finishing run forever on a hung keychain/network.
    vi.useFakeTimers();
    const hung = new EventEmitter();
    hung.stdout = new EventEmitter();
    hung.stderr = new EventEmitter();
    hung.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => hung);

    const pending = findMergeRequestForBranch('claim/issue-1', '/repo');
    await vi.advanceTimersByTimeAsync(60000);
    expect(hung.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });

    // A late close must not flip the already-settled result.
    hung.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    vi.useRealTimers();
  });
});
