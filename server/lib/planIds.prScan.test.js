/**
 * `listOpenPullRequestHeadRefs` sentinel discipline (#3358).
 *
 * The claim scan uses open-PR head refs as a secondary net for detecting an
 * already-claimed PLAN item. Before this, ANY `gh` failure resolved to `[]` —
 * indistinguishable from "the repo has no open PRs" — so a firewalled `gh`
 * silently removed the net with nothing in the log to say so.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('./childProcess.js', () => ({ spawn: (...args) => spawnMock(...args) }));

const { listOpenPullRequestHeadRefs } = await import('./planIds.js');

/** A fake `gh pr list` child that writes `stdout` then exits with `code`. */
const ghChild = ({ code = 0, stdout = '', spawnError = null } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (spawnError) child.emit('error', spawnError);
    else child.emit('close', code);
  });
  return child;
};

// A benign DEFAULT (exits 0 with no output) with each case layered on via
// `mockImplementationOnce`: the child_process mock is process-wide for this
// file's graph, so leaving a spawn-error implementation installed would hand a
// synthetic ENOENT to any unrelated spawn that fires during teardown.
beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => ghChild({ code: 0, stdout: '' }));
});

describe('listOpenPullRequestHeadRefs (#3358)', () => {
  it('returns the head refs gh reported', async () => {
    spawnMock.mockImplementationOnce(() => ghChild({ stdout: 'claim/issue-1\ncos/task/slug/agent\n' }));
    await expect(listOpenPullRequestHeadRefs('/repo')).resolves.toEqual(['claim/issue-1', 'cos/task/slug/agent']);
  });

  it('returns [] — an ANSWER — when gh reports no open PRs', async () => {
    spawnMock.mockImplementationOnce(() => ghChild({ stdout: '' }));
    await expect(listOpenPullRequestHeadRefs('/repo')).resolves.toEqual([]);
  });

  it('returns null (not []) when gh exits non-zero', async () => {
    spawnMock.mockImplementationOnce(() => ghChild({ code: 1 }));
    await expect(listOpenPullRequestHeadRefs('/repo')).resolves.toBeNull();
  });

  it('returns null (not []) when gh is missing entirely', async () => {
    spawnMock.mockImplementationOnce(() => ghChild({
      spawnError: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    }));
    await expect(listOpenPullRequestHeadRefs('/repo')).resolves.toBeNull();
  });

  it('returns null when the call times out, and the close handler cannot re-settle it', async () => {
    vi.useFakeTimers();
    const hung = new EventEmitter();
    hung.stdout = new EventEmitter();
    hung.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => hung);

    const pending = listOpenPullRequestHeadRefs('/repo');
    await vi.advanceTimersByTimeAsync(15000);
    expect(hung.kill).toHaveBeenCalled();
    await expect(pending).resolves.toBeNull();

    // A late close must not flip the already-settled promise.
    hung.emit('close', 0);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});
