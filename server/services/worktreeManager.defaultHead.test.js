// Real git: a review-loop follow-up for a PR whose head branch is the default
// branch (a release PR, main -> release) must get a worktree on its first
// attempt. `git worktree add main` is refused while the primary checkout holds
// it, so the follow-up attaches DETACHED at the reviewed commit instead.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { writeFile, mkdir, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot, mockTestIdentity } from '../lib/mockPathsDataRoot.js';
import { destroyGitSandbox, makeGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-worktree-defaulthead-' });
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
const { PATHS } = await import('../lib/fileUtils.js');
const { createWorktree, removeWorktree, PINNED_HEAD_MOVED } = await import('./worktreeManager.js');
afterAll(cleanup);

const FEATURE = 'contributor/fix-thing';
const git = async (args, cwd) => (await execGit(args, cwd)).stdout.trim();

async function commitOnto(cwd, file) {
  await writeFile(join(cwd, file), `${file}\n`);
  await execGit(['add', file], cwd);
  await execGit(['commit', '-m', file], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('createWorktree for a PR whose head branch the primary checkout holds', () => {
  let sandbox;
  beforeEach(async () => {
    if (sandbox) await destroyGitSandbox(sandbox.scratch);
    sandbox = await makeGitSandbox({ origin: true, prefix: 'portos-defaulthead-' });
  });
  afterAll(async () => { if (sandbox) await destroyGitSandbox(sandbox.scratch); });

  it('detaches at the default-branch head on the first attempt and leaves the primary checkout alone', async () => {
    const head = await commitOnto(sandbox.repo, 'release-notes.txt');
    await execGit(['push', 'origin', 'main'], sandbox.repo);

    const info = await createWorktree('agent-release', sandbox.repo, 'task-release', { existingBranch: 'main' });

    expect(info).toMatchObject({ detached: true, headIsDefaultBranch: true, headSha: head, existingBranch: true });
    expect(await git(['rev-parse', 'HEAD'], info.worktreePath)).toBe(head);
    // Detached: `git push` has no branch to default to.
    expect((await execGit(['symbolic-ref', '-q', 'HEAD'], info.worktreePath, { ignoreExitCode: true })).exitCode).not.toBe(0);
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], sandbox.repo)).toBe('main');
  });

  it('pins the detached head to the reviewed commit and refuses once the default branch moved', async () => {
    const reviewed = await commitOnto(sandbox.repo, 'reviewed.txt');
    await execGit(['push', 'origin', 'main'], sandbox.repo);

    const info = await createWorktree('agent-pinned', sandbox.repo, 'task-pinned', { existingBranch: 'main', expectedHeadSha: reviewed });
    expect(info).toMatchObject({ detached: true, headIsDefaultBranch: true, headSha: reviewed });
    expect(await git(['rev-parse', 'HEAD'], info.worktreePath)).toBe(reviewed);

    await commitOnto(sandbox.repo, 'unreviewed.txt');
    await execGit(['push', 'origin', 'main'], sandbox.repo);
    await expect(createWorktree('agent-moved', sandbox.repo, 'task-moved', { existingBranch: 'main', expectedHeadSha: reviewed }))
      .rejects.toMatchObject({ code: PINNED_HEAD_MOVED });
    expect(existsSync(join(PATHS.worktrees, 'agent-moved'))).toBe(false);
  });

  it('detaches a non-default branch the primary checkout has checked out, without flagging it as the default', async () => {
    await execGit(['checkout', '-b', FEATURE], sandbox.repo);
    const head = await commitOnto(sandbox.repo, 'feature.txt');
    await execGit(['push', 'origin', FEATURE], sandbox.repo);

    const info = await createWorktree('agent-held', sandbox.repo, 'task-held', { existingBranch: FEATURE });

    expect(info).toMatchObject({ detached: true, headIsDefaultBranch: false, headSha: head });
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], sandbox.repo)).toBe(FEATURE);
  });

  it('still attaches an ordinary feature-branch PR by name', async () => {
    await execGit(['checkout', '-b', FEATURE], sandbox.repo);
    const head = await commitOnto(sandbox.repo, 'feature.txt');
    await execGit(['push', 'origin', FEATURE], sandbox.repo);
    await execGit(['checkout', 'main'], sandbox.repo);
    await execGit(['branch', '-D', FEATURE], sandbox.repo);

    const info = await createWorktree('agent-feature', sandbox.repo, 'task-feature', { existingBranch: FEATURE });

    expect(info.detached).toBeUndefined();
    expect(info.headIsDefaultBranch).toBeUndefined();
    expect(info.branchName).toBe(FEATURE);
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], info.worktreePath)).toBe(FEATURE);
    expect(await git(['rev-parse', 'HEAD'], info.worktreePath)).toBe(head);
  });

  it('discards ignored output with an integrated no-PR job', async () => {
    await execGit(['push', 'origin', 'main'], sandbox.repo);
    const info = await createWorktree('agent-no-change', sandbox.repo, 'task-no-change');
    await writeFile(join(sandbox.repo, '.git/info/exclude'), '.cache/\n');
    await mkdir(join(info.worktreePath, '.cache/pregate'), { recursive: true });
    await writeFile(join(info.worktreePath, '.cache/pregate/report.json'), JSON.stringify({ validationMode: 'focused' }));
    await writeFile(join(info.worktreePath, '.cache/pregate/unique.json'), '{"scratch":true}');
    const result = await removeWorktree('agent-no-change', sandbox.repo, info.branchName, { merge: false });
    expect(result, JSON.stringify(result)).toMatchObject({ removed: true });
    expect(existsSync(info.worktreePath)).toBe(false);
    expect((await execGit(['show-ref', '--verify', `refs/heads/${info.branchName}`], sandbox.repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
  });

  it('still retains an integrated checkout holding untracked, non-ignored work', async () => {
    await execGit(['push', 'origin', 'main'], sandbox.repo);
    const info = await createWorktree('agent-untracked', sandbox.repo, 'task-untracked');
    const file = join(info.worktreePath, 'unpublished-notes.md');
    await writeFile(file, 'sole copy');
    expect(await removeWorktree('agent-untracked', sandbox.repo, info.branchName, { merge: false }))
      .toMatchObject({ removed: false });
    expect(await readFile(file, 'utf8')).toBe('sole copy');
    expect(await git(['rev-parse', `refs/heads/${info.branchName}`], sandbox.repo)).toBe(await git(['rev-parse', 'HEAD'], info.worktreePath));
  });

  describe('removeWorktree on the detached checkout', () => {
    it('retires a clean published checkout without touching the default branch ref or the primary checkout', async () => {
      await commitOnto(sandbox.repo, 'release-notes.txt');
      await execGit(['push', 'origin', 'main'], sandbox.repo);
      const mainBefore = await git(['rev-parse', 'refs/heads/main'], sandbox.repo);
      const info = await createWorktree('agent-clean', sandbox.repo, 'task-clean', { existingBranch: 'main' });

      const result = await removeWorktree('agent-clean', sandbox.repo, 'main', { merge: false });

      expect(result).toMatchObject({ removed: true });
      expect(existsSync(info.worktreePath)).toBe(false);
      expect(await git(['rev-parse', 'refs/heads/main'], sandbox.repo)).toBe(mainBefore);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], sandbox.repo)).toBe('main');
    });

    it('keeps a checkout holding a commit no remote branch contains', async () => {
      await execGit(['push', 'origin', 'main'], sandbox.repo);
      const info = await createWorktree('agent-unpublished', sandbox.repo, 'task-unpublished', { existingBranch: 'main' });
      await commitOnto(info.worktreePath, 'stray-fix.txt');

      const result = await removeWorktree('agent-unpublished', sandbox.repo, 'main', { merge: false });

      expect(result.removed).toBe(false);
      expect(result.warnings.join(' ')).toContain('detached-head-unpublished');
      expect(existsSync(info.worktreePath)).toBe(true);
    });
  });
});
