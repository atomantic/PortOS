import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./execGit.js', () => ({ execGit: vi.fn() }));

import { execGit } from './execGit.js';
import { commitsSince, committedDuringRun } from './gitCommitProbe.js';

const SINCE = Date.parse('2026-08-08T18:23:30.000Z');

beforeEach(() => vi.clearAllMocks());

describe('commitsSince (#3637)', () => {
  it('counts commits inside the run window, scoped by committer date', async () => {
    vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: '2\n', stderr: '' });
    expect(await commitsSince('/tmp/ws', SINCE)).toBe(2);
    expect(execGit).toHaveBeenCalledWith(
      ['rev-list', '--count', '--since=2026-08-08T18:23:30.000Z', 'HEAD'],
      '/tmp/ws',
      { ignoreExitCode: true }
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
