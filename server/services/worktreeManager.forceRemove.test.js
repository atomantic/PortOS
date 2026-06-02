import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the two side-effecting deps so we can assert the fallback dance without
// touching git or the filesystem. Kept in its own test file so the pure-logic
// suite in worktreeManager.test.js stays mock-free.
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rm: vi.fn() };
});

import { execGit } from '../lib/execGit.js';
import { rm } from 'fs/promises';
import { forceRemoveWorktreeDir } from './worktreeManager.js';

describe('forceRemoveWorktreeDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('happy path: a successful `worktree remove --force` skips the rm + prune fallback', async () => {
    execGit.mockResolvedValue({ stdout: '', stderr: '' });
    await forceRemoveWorktreeDir('/repo', '/repo/wt');
    expect(execGit).toHaveBeenCalledTimes(1);
    expect(execGit).toHaveBeenCalledWith(['worktree', 'remove', '/repo/wt', '--force'], '/repo');
    expect(rm).not.toHaveBeenCalled();
  });

  it('fallback: when remove rejects, rm -rf then `worktree prune` run', async () => {
    // First call (remove) rejects; second call (prune) resolves.
    execGit.mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce({ stdout: '', stderr: '' });
    rm.mockResolvedValue();
    await forceRemoveWorktreeDir('/repo', '/repo/wt');
    expect(rm).toHaveBeenCalledWith('/repo/wt', { recursive: true, force: true });
    expect(execGit).toHaveBeenCalledTimes(2);
    expect(execGit).toHaveBeenLastCalledWith(['worktree', 'prune'], '/repo');
  });

  it('never throws even when the rm AND prune fallbacks also fail (best-effort cleanup)', async () => {
    execGit.mockRejectedValueOnce(new Error('remove failed')).mockRejectedValueOnce(new Error('prune failed'));
    rm.mockRejectedValue(new Error('rm failed'));
    await expect(forceRemoveWorktreeDir('/repo', '/repo/wt')).resolves.toBeUndefined();
  });

  it('label gates the remove-failure log; absent label stays silent', async () => {
    execGit.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ stdout: '', stderr: '' });
    rm.mockResolvedValue();

    await forceRemoveWorktreeDir('/repo', '/repo/wt', { label: 'Remove failed for agent-1' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('⚠️ Remove failed for agent-1: boom'));

    console.log.mockClear();
    execGit.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ stdout: '', stderr: '' });
    await forceRemoveWorktreeDir('/repo', '/repo/wt'); // no label
    expect(console.log).not.toHaveBeenCalled();
  });

  it("log:'all' gates the rm + prune sub-failure logs", async () => {
    execGit.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('prune boom'));
    rm.mockRejectedValue(new Error('rm boom'));

    // default log:'remove' → only the labelled remove line, no rm/prune lines
    await forceRemoveWorktreeDir('/repo', '/repo/wt', { label: 'L' });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('⚠️ L: boom'));

    console.log.mockClear();
    execGit.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('prune boom'));
    rm.mockRejectedValue(new Error('rm boom'));
    // log:'all' → remove line + rm-failure line + prune-failure line (3 logs)
    await forceRemoveWorktreeDir('/repo', '/repo/wt', { label: 'L', log: 'all' });
    expect(console.log).toHaveBeenCalledTimes(3);
  });

  it("subject identifies the rm/prune sub-failures (defaults to the path, overridable to an agent id)", async () => {
    // Default subject = worktreePath.
    execGit.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('prune boom'));
    rm.mockRejectedValue(new Error('rm boom'));
    await forceRemoveWorktreeDir('/repo', '/repo/wt', { label: 'L', log: 'all' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Manual rm failed for worktree /repo/wt'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Worktree prune failed for /repo/wt'));

    // Override subject → the agent id appears instead (preserves pre-extraction wording).
    console.log.mockClear();
    execGit.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('prune boom'));
    rm.mockRejectedValue(new Error('rm boom'));
    await forceRemoveWorktreeDir('/repo', '/repo/wt', { label: 'L', log: 'all', subject: 'agent-42' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Manual rm failed for worktree agent-42'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Worktree prune failed for agent-42'));
  });
});
