import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('./execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('./primaryCheckoutGuard.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveRemoteDefaultRef: vi.fn(),
}));

import { execGit } from './execGit.js';
import { resolveRemoteDefaultRef } from './primaryCheckoutGuard.js';
import { commitsSince, committedDuringRun, runWindowDiff, toEpochMs } from './gitCommitProbe.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from './gitTestRepo.js';

const SINCE = Date.parse('2026-08-08T18:23:30.000Z');

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveRemoteDefaultRef).mockResolvedValue(null);
});

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
  const headOk = { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };

  beforeEach(() => {
    vi.mocked(execGit).mockResolvedValueOnce(headOk);
  });

  it('diffs the newest pre-window commit against HEAD, so a multi-commit run reads as one change', async () => {
    vi.mocked(execGit)
      .mockResolvedValueOnce(baseOk)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'diff --git a/a.js b/a.js\n+ok\n', stderr: '' });

    expect(await runWindowDiff('/tmp/ws', SINCE)).toEqual({
      diff: 'diff --git a/a.js b/a.js\n+ok\n',
      base: 'b'.repeat(40),
      head: 'a'.repeat(40),
      truncated: false,
      reason: null,
    });
    // Older persisted records still work with only a timestamp, and a checkout
    // without a remote default retains the original time-window fallback.
    expect(execGit).toHaveBeenNthCalledWith(2,
      ['rev-list', '-n', '1', '--before=2026-08-08T18:23:30.000Z', 'a'.repeat(40)],
      '/tmp/ws',
      { ignoreExitCode: true, timeout: 10_000 }
    );
    expect(execGit).toHaveBeenNthCalledWith(3,
      ['diff', '--no-color', '--no-ext-diff', `${'b'.repeat(40)}..${'a'.repeat(40)}`],
      '/tmp/ws',
      { ignoreExitCode: true, timeout: 30_000 }
    );
  });

  it('distinguishes "the run changed nothing" from "git could not answer"', async () => {
    vi.mocked(execGit).mockResolvedValueOnce(baseOk).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({ diff: '', reason: null });

    vi.clearAllMocks();
    vi.mocked(execGit).mockResolvedValueOnce(headOk).mockResolvedValueOnce(baseOk).mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'bad revision' });
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
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({ diff: null, head: null, reason: 'could not resolve the run window head commit' });
  });

  it('truncates and flags an oversized diff rather than handing a fixed-window model more than it can read', async () => {
    vi.mocked(execGit).mockResolvedValueOnce(baseOk).mockResolvedValueOnce({ exitCode: 0, stdout: 'x'.repeat(500), stderr: '' });
    const result = await runWindowDiff('/tmp/ws', SINCE, { maxChars: 100 });
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('[diff truncated]');
    expect(result.diff.length).toBeLessThan(200);
  });

  it('declines an unavailable upstream comparison instead of grading an unfiltered diff', async () => {
    vi.mocked(resolveRemoteDefaultRef).mockResolvedValue({ ref: 'origin/main', sha: 'c'.repeat(40) });
    vi.mocked(execGit).mockResolvedValueOnce(baseOk).mockRejectedValueOnce(new Error('timed out'));
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({
      diff: null, reason: 'could not resolve the absorbed upstream base',
    });
    expect(execGit.mock.calls.some(([args]) => args[0] === 'diff')).toBe(false);
  });

  it('declines incomparable pre-window agent and absorbed upstream bases', async () => {
    vi.mocked(resolveRemoteDefaultRef).mockResolvedValue({ ref: 'origin/main', sha: 'c'.repeat(40) });
    vi.mocked(execGit)
      .mockResolvedValueOnce(baseOk)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'c'.repeat(40), stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    expect(await runWindowDiff('/tmp/ws', SINCE)).toMatchObject({
      diff: null, reason: 'run window and upstream bases could not be ordered',
    });
    expect(execGit.mock.calls.some(([args]) => args[0] === 'diff')).toBe(false);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('runWindowDiff real git history (#7690)', () => {
  it.each(['rebase', 'merge'])('excludes upstream absorbed by %s while retaining all run commits', async (operation) => {
    const { execGit: realExecGit } = await vi.importActual('./execGit.js');
    const { resolveRemoteDefaultRef: realResolveRemoteDefaultRef } = await vi.importActual('./primaryCheckoutGuard.js');
    vi.mocked(execGit).mockImplementation(realExecGit);
    vi.mocked(resolveRemoteDefaultRef).mockImplementation(realResolveRemoteDefaultRef);
    const sandbox = await makeGitSandbox();
    const git = (args) => realExecGit(args, sandbox.repo);
    const commit = async (file, text, date) => {
      vi.stubEnv('GIT_COMMITTER_DATE', date);
      await writeFile(join(sandbox.repo, file), text);
      await git(['add', file]);
      await git(['commit', '--date', date, '-m', 'fixture change']);
    };
    try {
      const before = '2026-08-08T18:00:00Z';
      vi.stubEnv('GIT_COMMITTER_DATE', before);
      await git(['commit', '--amend', '--no-edit', '--date', before]);
      const initial = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      // A nonstandard default verifies origin/HEAD resolution, including on a
      // detached agent HEAD. Ref updates are local: no network or live remote.
      await git(['branch', '-m', 'trunk']);
      await git(['update-ref', 'refs/remotes/origin/trunk', initial]);
      await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
      await git(['checkout', '-b', 'agent']);
      await commit('agent.txt', 'first change\n', '2026-08-08T18:24:00Z');
      await git(['checkout', 'trunk']);
      await commit('upstream.txt', 'other work\n', '2026-08-08T18:25:00Z');
      const absorbed = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      await git(['update-ref', 'refs/remotes/origin/trunk', absorbed]);
      await git(['checkout', 'agent']);
      vi.stubEnv('GIT_COMMITTER_DATE', '2026-08-08T18:26:00Z');
      await git(operation === 'rebase' ? ['rebase', 'trunk'] : ['merge', '--no-edit', 'trunk']);
      await commit('agent.txt', 'first change\nsecond change\n', '2026-08-08T18:27:00Z');
      await git(['checkout', '--detach']);
      // A later upstream commit has NOT been absorbed; diffing against the
      // remote tip would manufacture a deletion of this file.
      const runHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      await git(['checkout', 'trunk']);
      await commit('future-upstream.txt', 'not absorbed\n', '2026-08-08T18:28:00Z');
      await git(['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
      await git(['checkout', '--detach', runHead]);
      // Characterize the old probe: its date-only diff contains unrelated work.
      const oldBase = (await git(['rev-list', '-n', '1', '--before=2026-08-08T18:23:30Z', 'HEAD'])).stdout.trim();
      expect((await git(['diff', `${oldBase}..HEAD`])).stdout).toContain('upstream.txt');
      const result = await runWindowDiff(sandbox.repo, SINCE);
      expect(result).toMatchObject({ base: absorbed, head: runHead, reason: null, truncated: false });
      expect(result.diff).toBe((await git(['diff', '--no-color', '--no-ext-diff', `${result.base}..${result.head}`])).stdout);
      expect(result.diff).toContain('+first change');
      expect(result.diff).toContain('+second change');
      expect(result.diff).not.toContain('upstream.txt');
      // A legacy record whose run started later must not re-include earlier
      // agent work just because the remote-default merge base is older.
      const later = await runWindowDiff(sandbox.repo, Date.parse('2026-08-08T18:26:30Z'));
      expect(later.reason).toBeNull();
      expect(later.diff).toContain('+second change');
      expect(later.diff).not.toContain('+first change');
      expect(later.diff).not.toContain('upstream.txt');
      await git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
      await git(['update-ref', '-d', 'refs/remotes/origin/trunk']);
      const legacyFallback = await runWindowDiff(sandbox.repo, SINCE);
      expect(legacyFallback).toMatchObject({ base: oldBase, reason: null });
      expect(legacyFallback.diff).toContain('upstream.txt');
    } finally {
      vi.unstubAllEnvs();
      await destroyGitSandbox(sandbox.scratch);
    }
  });
});
