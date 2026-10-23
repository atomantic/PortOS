import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { getGitInfo, rebaseAndPushDefaultBranch } from './git.js';

// Real Git pins preservation, rebase conflict cleanup and the exact push target.
describe.skipIf(SKIP_HEAVY_INTEGRATION)('rebase and push the default branch', () => {
  let sandbox;
  afterEach(async () => {
    if (sandbox) await destroyGitSandbox(sandbox.scratch);
    sandbox = null;
  });
  const commitFile = async (repo, file, body) => {
    await writeFile(join(repo, file), body);
    await execGit(['add', file], repo);
    await execGit(['commit', '-m', `Update ${file}`], repo);
  };
  const head = async repo => (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
  const prepare = async ({ conflict = false } = {}) => {
    sandbox = await makeGitSandbox({ origin: true });
    const { repo, scratch, origin } = sandbox;
    const other = join(scratch, 'other');
    await execGit(['clone', origin, other], scratch);
    await execGit(['config', 'user.email', 'agent@example.com'], other);
    await execGit(['config', 'user.name', 'Example Agent'], other);
    await execGit(['config', 'commit.gpgsign', 'false'], other);
    await commitFile(other, conflict ? 'initial.txt' : 'remote.txt', 'remote change\n');
    await execGit(['push', 'origin', 'HEAD:main'], other);
    await commitFile(repo, conflict ? 'initial.txt' : 'local.txt', 'local change\n');
    return repo;
  };

  it('reports origin divergence independently of tracking and publishes both sides without a merge commit', async () => {
    const repo = await prepare();
    await execGit(['fetch', 'origin'], repo);
    await execGit(['branch', '--unset-upstream'], repo);
    expect(await getGitInfo(repo)).toMatchObject({ originComparison: { ahead: 1, behind: 1 } });
    const result = await rebaseAndPushDefaultBranch(repo);
    expect(result).toMatchObject({ success: true, pulled: true, pushed: true, branch: 'main' });
    expect(await head(sandbox.origin)).toBe(await head(repo));
    expect(await readFile(join(repo, 'remote.txt'), 'utf8')).toBe('remote change\n');
    expect(await readFile(join(repo, 'local.txt'), 'utf8')).toBe('local change\n');
    expect((await execGit(['rev-list', '--count', '--merges', 'HEAD'], repo)).stdout.trim()).toBe('0');
  });

  it('pushes an ahead-only default branch', async () => {
    sandbox = await makeGitSandbox({ origin: true });
    await commitFile(sandbox.repo, 'local.txt', 'local change\n');
    expect(await rebaseAndPushDefaultBranch(sandbox.repo)).toMatchObject({ success: true, pushed: true });
    expect(await head(sandbox.origin)).toBe(await head(sandbox.repo));
  });

  it('refuses overlapping requests and permits a later retry after completion', async () => {
    const repo = await prepare();
    const first = rebaseAndPushDefaultBranch(repo);
    await expect(rebaseAndPushDefaultBranch(repo)).rejects.toMatchObject({ code: 'GIT_BUSY' });
    expect(await first).toMatchObject({ success: true });
    expect(await rebaseAndPushDefaultBranch(repo)).toMatchObject({ success: false, error: expect.stringContaining('no local commits') });
  });

  it('aborts its conflicting rebase, preserving local and remote heads', async () => {
    const repo = await prepare({ conflict: true });
    const [local, remote] = await Promise.all([head(repo), head(sandbox.origin)]);
    const result = await rebaseAndPushDefaultBranch(repo);
    expect(result).toMatchObject({ success: false, pushed: false });
    expect(result.error).toMatch(/CONFLICT|could not apply/);
    expect(await head(repo)).toBe(local);
    expect(await head(sandbox.origin)).toBe(remote);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect((await execGit(['status', '--porcelain'], repo)).stdout).toBe('');
  });

  it('leaves another in-progress rebase untouched', async () => {
    const repo = await prepare({ conflict: true });
    await execGit(['fetch', 'origin'], repo);
    await execGit(['rebase', 'origin/main'], repo, { ignoreExitCode: true });
    expect(await rebaseAndPushDefaultBranch(repo)).toMatchObject({ success: false, error: expect.stringContaining('already in progress') });
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
  });

  it('refuses dirty work and a feature branch without modifying either', async () => {
    const repo = await prepare();
    await writeFile(join(repo, 'untracked.txt'), 'keep me');
    expect(await rebaseAndPushDefaultBranch(repo)).toMatchObject({ success: false, error: expect.stringContaining('local changes') });
    expect(await readFile(join(repo, 'untracked.txt'), 'utf8')).toBe('keep me');
    await execGit(['checkout', '-b', 'feature/work'], repo);
    expect(await rebaseAndPushDefaultBranch(repo)).toMatchObject({ success: false, error: expect.stringContaining('default branch') });
  });

  it('reports a rejected push and preserves rebased commits locally', async () => {
    const repo = await prepare();
    const remote = await head(sandbox.origin);
    // A repository without the requested push destination provides a portable
    // rejection without shell hooks (including on Windows).
    await execGit(['remote', 'set-url', '--push', 'origin', join(sandbox.scratch, 'missing.git')], repo);
    const result = await rebaseAndPushDefaultBranch(repo);
    expect(result).toMatchObject({ success: false, pulled: true, pushed: false });
    expect(result.error).toBeTruthy();
    expect(await head(sandbox.origin)).toBe(remote);
    expect(await readFile(join(repo, 'local.txt'), 'utf8')).toBe('local change\n');
  });
});
