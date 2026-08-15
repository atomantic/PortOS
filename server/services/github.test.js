import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from '../lib/childProcess.js';
import { execGh, getPullRequestState } from './github.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('execGh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a timeout error and kills the child when it never closes', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'slow'], 50);
    // Suppress unhandled-rejection noise until we await below.
    promise.catch(() => {});
    vi.advanceTimersByTime(50);
    await expect(promise).rejects.toThrow(/timed out after 50ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('resolves with trimmed stdout on a successful close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'repos'], 5000);
    child.stdout.emit('data', Buffer.from('  {"ok":true}  \n'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('{"ok":true}');
  });

  it('rejects with stderr on a non-zero close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'bad'], 5000);
    child.stderr.emit('data', Buffer.from('not found'));
    child.emit('close', 1);
    await expect(promise).rejects.toThrow(/not found/);
  });

  it('falls back to a generic error message when stderr is empty on non-zero close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'bad'], 5000);
    child.emit('close', 7);
    await expect(promise).rejects.toThrow(/gh exited with code 7/);
  });

  it('does not fire the timeout timer on a fast normal completion', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'fast'], 5000);
    child.stdout.emit('data', Buffer.from('done'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('done');
    // Advancing well past the timeout must not reject/kill after settling.
    vi.advanceTimersByTime(10000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rejects on a child spawn error', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'x'], 5000);
    child.emit('error', new Error('spawn gh ENOENT'));
    await expect(promise).rejects.toThrow(/ENOENT/);
  });
});

// The merge-follow-up reaper turns "the forge says this PR is OPEN" into a
// needs-manual-finish failure and "we could not ask" into leave-prior-behavior-
// alone, so collapsing those two answers is the whole hazard this shape exists
// to prevent (same discipline as findPullRequestForBranch, #3358).
describe('getPullRequestState', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const run = (prRef, drive) => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = getPullRequestState(prRef);
    drive(child);
    return promise;
  };

  it('reports a known MERGED state, upper-cased', async () => {
    await expect(run('https://example.test/o/r/pull/7', (c) => {
      c.stdout.emit('data', Buffer.from('{"state":"merged"}'));
      c.emit('close', 0);
    })).resolves.toEqual({ status: 'known', state: 'MERGED', detail: null });
  });

  it('reports a known OPEN state rather than collapsing it into "not merged"', async () => {
    const res = await run('7', (c) => {
      c.stdout.emit('data', Buffer.from('{"state":"OPEN"}'));
      c.emit('close', 0);
    });
    expect(res).toEqual({ status: 'known', state: 'OPEN', detail: null });
  });

  it('passes the PR reference straight to `gh pr view --json state`', async () => {
    await run('https://example.test/o/r/pull/7', (c) => {
      c.stdout.emit('data', Buffer.from('{"state":"MERGED"}'));
      c.emit('close', 0);
    });
    expect(spawn).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'https://example.test/o/r/pull/7', '--json', 'state'],
      expect.anything()
    );
  });

  it('reports unavailable — NOT a state — when gh fails (the firewalled-gh case)', async () => {
    const res = await run('7', (c) => {
      c.stderr.emit('data', Buffer.from('dial tcp: connect: bad file descriptor'));
      c.emit('close', 1);
    });
    expect(res.status).toBe('unavailable');
    expect(res.state).toBeNull();
    expect(res.detail).toMatch(/bad file descriptor/);
  });

  it('reports unavailable when a zero-exit gh emits nothing parseable', async () => {
    const res = await run('7', (c) => {
      c.stdout.emit('data', Buffer.from('not json'));
      c.emit('close', 0);
    });
    expect(res).toEqual({ status: 'unavailable', state: null, detail: 'gh returned unparseable output' });
  });

  it('reports unavailable without shelling out when given no reference', async () => {
    await expect(getPullRequestState('')).resolves.toEqual({ status: 'unavailable', state: null, detail: 'no PR reference' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
