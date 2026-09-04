import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./execGit.js', () => ({ execGit: vi.fn() }));

import { execGit } from './execGit.js';
import { commitsSince, committedDuringRun, runWindowDiff, toEpochMs } from './gitCommitProbe.js';

const SINCE = Date.parse('2026-08-08T18:23:30.000Z');

beforeEach(() => vi.clearAllMocks());

describe('commitsSince (#3637)', () => {
  it('counts commits inside the run window, scoped by committer date', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: '2\n', stderr: '' });
    expect(await commitsSince('/tmp/ws', SINCE)).toBe(2);
    expect(execGit).toHaveBeenCalledWith(
      ['rev-list', '--count', '--since=2026-08-08T18:23:30.000Z', 'HEAD'],
      '/tmp/ws',
      { ignoreExitCode: true, timeout: 10_000 }
    );
  });

  it('is 0 when nothing was committed during the run', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: '0\n', stderr: '' });
    expect(await commitsSince('/tmp/ws', SINCE)).toBe(0);
  });

  // A repo with no commits yet makes `rev-list HEAD` exit non-zero with an empty
  // stdout — parsing that as work would launder a no-op run into a success.
  it('is 0 on a non-zero git exit (no HEAD / broken checkout)', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'bad revision' });
    expect(await commitsSince('/tmp/ws', SINCE)).toBe(0);
  });

  it('is 0 (never throws) when execGit rejects', async () => {
    vi.mocked(execGit).mockRejectedValue(new Error('timed out'));
    expect(await commitsSince('/tmp/ws', SINCE)).toBe(0);
  });

  it('is 0 for unparseable output', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: 'not-a-number\n', stderr: '' });
    expect(await commitsSince('/tmp/ws', SINCE)).toBe(0);
  });

  it('is 0 for a bad path or a non-finite timestamp without touching git', async () => {
    expect(await commitsSince(null, SINCE)).toBe(0);
    expect(await commitsSince('', SINCE)).toBe(0);
    expect(await commitsSince('/tmp/ws', undefined)).toBe(0);
    expect(await commitsSince('/tmp/ws', NaN)).toBe(0);
    expect(execGit).not.toHaveBeenCalled();
  });

  // `Number.isFinite` passes these, but `new Date(x).toISOString()` throws
  // RangeError on them — which would break the non-throwing contract on a path
  // that runs outside the request lifecycle.
  it('is 0 (never throws) for a finite but out-of-range epoch', async () => {
    // The Date range is ±8.64e15 ms; beyond it `toISOString()` throws.
    expect(await commitsSince('/tmp/ws', 1e16)).toBe(0);
    expect(await commitsSince('/tmp/ws', -1e16)).toBe(0);
    expect(execGit).not.toHaveBeenCalled();
  });

  // The retired marker grep bounded its git at 10s; execGit's own default is 30s,
  // and this runs on the agent-completion path, so the tighter bound is explicit.
  it('bounds the git call at 10s rather than taking execGit’s 30s default', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: '0\n', stderr: '' });
    await commitsSince('/tmp/ws', SINCE);
    expect(execGit).toHaveBeenCalledWith(expect.anything(), '/tmp/ws', { ignoreExitCode: true, timeout: 10_000 });
  });
});

describe('toEpochMs (#3637)', () => {
  // The in-memory agent maps stamp `Date.now()` (a number); the persisted record
  // stamps an ISO string. A bare `Date.parse` silently drops the numeric half —
  // `Date.parse(1754696324000)` stringifies its argument and returns NaN — which
  // would skip the commit probe for every live runner/TUI/CLI run.
  it('passes a numeric epoch through untouched', () => {
    expect(toEpochMs(1754696324000)).toBe(1754696324000);
    expect(toEpochMs(0)).toBe(0);
  });

  it('parses the persisted ISO string', () => {
    expect(toEpochMs('2026-08-09T00:00:00.000Z')).toBe(Date.parse('2026-08-09T00:00:00.000Z'));
  });

  it('accepts a Date instance', () => {
    expect(toEpochMs(new Date(1754696324000))).toBe(1754696324000);
  });

  it('is NaN for anything unusable, so callers can gate on Number.isFinite', () => {
    for (const bad of [null, undefined, {}, [], 'not-a-date']) {
      expect(Number.isFinite(toEpochMs(bad))).toBe(false);
    }
  });
});

describe('committedDuringRun (#3637)', () => {
  it('is true when the run left at least one commit behind', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: '1\n', stderr: '' });
    expect(await committedDuringRun('/tmp/ws', SINCE)).toBe(true);
  });

  it('is false when the run committed nothing', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: '0\n', stderr: '' });
    expect(await committedDuringRun('/tmp/ws', SINCE)).toBe(false);
  });
});

describe('runWindowDiff (#5994)', () => {
  const baseOk = { exitCode: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };

  it('diffs the newest pre-window commit against HEAD, so a multi-commit run reads as one change', async () => {
    vi.mocked(execGit)
      .mockResolvedValueOnce(baseOk)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'diff --git a/a.js b/a.js\n+ok\n', stderr: '' });

    expect(await runWindowDiff('/tmp/ws', SINCE)).toEqual({
      diff: 'diff --git a/a.js b/a.js\n+ok\n',
      base: 'b'.repeat(40),
      truncated: false,
      reason: null,
    });
    // The window is resolved on committer date, exactly as `commitsSince` filters
    // on it — the two probes must never disagree about which commits are the run's.
    expect(execGit).toHaveBeenNthCalledWith(1,
      ['rev-list', '-n', '1', '--before=2026-08-08T18:23:30.000Z', 'HEAD'],
      '/tmp/ws',
      { ignoreExitCode: true, timeout: 10_000 }
    );
    expect(execGit).toHaveBeenNthCalledWith(2,
      ['diff', '--no-color', '--no-ext-diff', `${'b'.repeat(40)}..HEAD`],
      '/tmp/ws',
      { ignoreExitCode: true, timeout: 30_000 }
    );
  });

  it('distinguishes "the run changed nothing" from "git could not answer"', async () => {
    vi.mocked(execGit).mockResolvedValueOnce(baseOk).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({ diff: '', reason: null });

    vi.clearAllMocks();
    vi.mocked(execGit).mockResolvedValueOnce(baseOk).mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'bad revision' });
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({ diff: null, reason: 'could not read the run window diff' });
  });

  it('declines (never throws) with a reason for an unusable window, an unresolvable base, and a rejecting git', async () => {
    expect(await runWindowDiff('', SINCE)).toMatchObject({ diff: null, reason: 'no workspace path' });
    expect(await runWindowDiff('/tmp/ws', NaN)).toMatchObject({ diff: null, reason: 'no run window' });
    expect(await runWindowDiff('/tmp/ws', 1e16)).toMatchObject({ diff: null, reason: 'unusable run window' });

    vi.mocked(execGit).mockResolvedValueOnce({ exitCode: 0, stdout: '\n', stderr: '' });
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({ diff: null, reason: 'no commit predates the run window' });

    vi.clearAllMocks();
    vi.mocked(execGit).mockRejectedValue(new Error('timed out'));
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({ diff: null, reason: 'could not resolve the run window base commit' });
  });

  it('truncates and flags an oversized diff rather than handing a fixed-window model more than it can read', async () => {
    vi.mocked(execGit).mockResolvedValueOnce(baseOk).mockResolvedValueOnce({ exitCode: 0, stdout: 'x'.repeat(500), stderr: '' });
    const result = await runWindowDiff('/tmp/ws', SINCE, { maxChars: 100 });
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('[diff truncated]');
    expect(result.diff.length).toBeLessThan(200);
  });
});
