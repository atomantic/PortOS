import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox } from '../lib/gitTestRepo.js';

const fixture = vi.hoisted(() => ({ remote: null, view: null, mergeError: false, viewError: false, queued: false, moveHead: false, defaultBranch: 'main', ambientAuth: false, pushes: [] }));
vi.mock('./forgeAuth.js', () => ({
  resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh', env: fixture.ambientAuth ? process.env : { ...process.env, GH_TOKEN: 'fixture-token' }, host: 'github.com', owner: 'fixture', account: 'fixture' })),
  resolveForgeTokenEnv: vi.fn(),
}));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('./gitlab.js', () => ({ execGlab: vi.fn() }));
// Replace only the synthetic HTTPS transport; Git still applies the real
// exact-ref lease to a private bare repository. No command reaches GitHub.
vi.mock('../lib/childProcess.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, spawn: (command, args, options) => {
    if (command === 'git' && args.includes('push') && args.includes('https://github.com/fixture/app.git')) {
      fixture.pushes.push({ args: [...args], env: options.env });
      return original.spawn(command, args.map(arg => arg === 'https://github.com/fixture/app.git' ? fixture.remote : arg), options);
    }
    return original.spawn(command, args, options);
  } };
});

import { execGh } from './github.js';
import { mergePR } from './git.js';
import { runForgeMerge } from './appPullRequestMerge.js';

let sandbox, worktree, head;
const git = async (args, cwd = sandbox.repo) => (await execGit(args, cwd)).stdout.trim();
const remoteHead = () => git(['rev-parse', '--verify', 'refs/heads/topic'], sandbox.origin);

beforeEach(async () => {
  vi.clearAllMocks();
  sandbox = await makeGitSandbox({ origin: true, prefix: 'portos-merge-pr-' });
  fixture.remote = sandbox.origin;
  fixture.mergeError = fixture.viewError = fixture.queued = fixture.moveHead = fixture.ambientAuth = false;
  fixture.defaultBranch = 'main';
  fixture.pushes = [];
  worktree = join(sandbox.scratch, 'linked');
  await git(['worktree', 'add', '-b', 'topic', worktree]);
  await writeFile(join(worktree, '.gitignore'), 'ignored-evidence.txt\n');
  await writeFile(join(worktree, 'change.txt'), 'reviewed work\n');
  await git(['add', '.'], worktree);
  await git(['commit', '-m', 'reviewed change'], worktree);
  head = await git(['rev-parse', 'HEAD'], worktree);
  await git(['push', 'origin', 'topic']);
  await git(['remote', 'set-url', '--push', 'origin', 'https://github.com/fixture/app.git']);
  await writeFile(join(worktree, 'ignored-evidence.txt'), 'unique ignored evidence\n');
  fixture.view = { state: 'MERGED', url: 'https://github.com/fixture/app/pull/42', headRefName: 'topic',
    headRefOid: head, baseRefName: 'main', isCrossRepository: false, headRepository: { nameWithOwner: 'fixture/app' } };
  execGh.mockImplementation(async args => {
    if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: fixture.defaultBranch ? { name: fixture.defaultBranch } : null });
    if (args[1] === 'view') {
      if (fixture.viewError) throw new Error('readback unavailable');
      return JSON.stringify(fixture.view);
    }
    expect(args.slice(0, 3)).toEqual(['pr', 'merge', '42']);
    if (!fixture.queued) {
      await git(['merge', '--no-ff', 'topic', '-m', 'merge reviewed PR']);
      await git(['push', sandbox.origin, 'main']);
    }
    // Model gh's destructive checkout-mode behavior ONLY inside this sandbox.
    // The regression must protect the actual ignored file, not just mock argv.
    if (args.includes('--delete-branch') && !args.includes('--repo')) {
      await git(['worktree', 'remove', '--force', worktree]);
      await git(['branch', '-D', 'topic']);
      await git(['push', sandbox.origin, '--delete', 'topic']);
    }
    if (fixture.moveHead) {
      const tree = await git(['rev-parse', `${head}^{tree}`]);
      const moved = await git(['commit-tree', tree, '-p', head, '-m', 'new source work']);
      await git(['push', sandbox.origin, `${moved}:refs/heads/topic`]);
    }
    if (fixture.mergeError) throw new Error('merge command timed out');
    return '';
  });
});

afterEach(async () => { await destroyGitSandbox(sandbox?.scratch); });

async function expectLocalEvidence() {
  expect(await readFile(join(worktree, 'ignored-evidence.txt'), 'utf8')).toBe('unique ignored evidence\n');
  expect(await git(['rev-parse', 'refs/heads/topic'])).toBe(head);
  expect(await git(['worktree', 'list', '--porcelain'])).toContain('branch refs/heads/topic');
}

describe('mergePR remote cleanup without checkout destruction', () => {
  it('preserves linked worktree and ignored evidence while deleting only the verified merged remote head', async () => {
    const result = await mergePR(sandbox.repo, 42, { expectedHeadSha: head });
    await expectLocalEvidence();
    expect(result).toMatchObject({ success: true, branchCleanup: { deleted: true, branch: 'topic' } });
    expect(await git(['ls-remote', 'origin', 'refs/heads/topic'])).toBe('');
    expect(await git(['merge-base', '--is-ancestor', head, 'main'])).toBe('');
    expect(execGh.mock.calls[0][0]).not.toContain('--delete-branch');
    expect(fixture.pushes).toHaveLength(1);
    expect(fixture.pushes[0].env).toMatchObject({ GH_TOKEN: 'fixture-token', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' });
    expect(fixture.pushes[0].args).toEqual(expect.arrayContaining(['credential.helper=', 'credential.helper=!gh auth git-credential', `--force-with-lease=refs/heads/topic:${head}`]));
  });

  it('retains new remote work when its head moves after the merged snapshot', async () => {
    fixture.moveHead = true;
    const result = await mergePR(sandbox.repo, 42, { expectedHeadSha: head });
    expect(result).toMatchObject({ success: true, branchCleanup: { deleted: false, reason: 'remote-delete-failed-or-uncertain' } });
    expect(await remoteHead()).not.toBe(head);
    await expectLocalEvidence();
  });

  it.each([
    ['fork source', { isCrossRepository: true, headRepository: { nameWithOwner: 'fork/app' } }, 'source-repository-unverified'],
    ['inconsistent source identity', { headRepository: { nameWithOwner: 'other/app' } }, 'source-repository-unverified'],
    ['base/source name collision', { baseRefName: 'topic' }, 'protected-or-unknown-source'],
    ['protected source', { headRefName: 'main' }, 'protected-or-unknown-source'],
  ])('retains refs for %s with an explicit reason', async (_name, override, reason) => {
    Object.assign(fixture.view, override);
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({
      success: true, branchCleanup: { deleted: false, reason },
    });
    expect(await remoteHead()).toBe(head);
  });

  it('does not report the reviewed change shipped when another head was merged', async () => {
    fixture.view.headRefOid = 'a'.repeat(40);
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({
      success: false, code: 'reviewed-head-changed', branchCleanup: { deleted: false, reason: 'reviewed-head-changed' },
    });
    expect(await remoteHead()).toBe(head);
    await expectLocalEvidence();
  });

  it('keeps unpinned legacy callers compatible without assuming deletion authority', async () => {
    expect(await mergePR(sandbox.repo, 42)).toMatchObject({ success: true,
      branchCleanup: { deleted: false, reason: 'reviewed-head-unavailable' } });
    expect(await remoteHead()).toBe(head);
  });

  it('does not target a different push repository or multiple push URLs', async () => {
    // Prevent the mock merge from pushing main through these deliberately
    // unsuitable destinations: the forge readback already reports MERGED.
    fixture.queued = true;
    await git(['remote', 'set-url', '--push', 'origin', 'https://github.test/other/app.git']);
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({
      success: true, branchCleanup: { deleted: false, reason: 'push-target-mismatch' },
    });
    await git(['remote', 'set-url', '--add', '--push', 'origin', sandbox.origin]);
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({
      success: true, branchCleanup: { deleted: false, reason: 'push-target-ambiguous' },
    });
    expect(await remoteHead()).toBe(head);
  });

  it('retains a custom default source even when the PR targets a different base', async () => {
    await git(['branch', 'trunk', 'topic']);
    await git(['push', sandbox.origin, 'trunk']);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], sandbox.origin);
    fixture.view.headRefName = fixture.defaultBranch = 'trunk';
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({
      success: true, branchCleanup: { deleted: false, reason: 'protected-default-source' },
    });
    expect(await git(['rev-parse', 'refs/heads/trunk'], sandbox.origin)).toBe(head);
    expect(fixture.pushes).toHaveLength(0);
  });

  it.each(['default-unavailable', 'ambient-token'])('retains the source when %s cannot establish cleanup authority', async mode => {
    if (mode === 'default-unavailable') fixture.defaultBranch = null;
    else fixture.ambientAuth = true;
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({
      success: true, branchCleanup: { deleted: false, reason: mode === 'default-unavailable' ? 'default-branch-unverified' : 'account-bound-push-unavailable' },
    });
    expect(await remoteHead()).toBe(head);
    expect(fixture.pushes).toHaveLength(0);
  });

  it('recognizes an already completed merge after a command error without retrying the merge', async () => {
    fixture.mergeError = true;
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({ success: true, branchCleanup: { deleted: true } });
    expect(execGh.mock.calls.filter(([args]) => args[1] === 'merge')).toHaveLength(1);
    await expectLocalEvidence();
  });

  it.each(['queued', 'unreadable'])('does not claim a %s merge succeeded or delete its source', async mode => {
    fixture.queued = true;
    fixture.view.state = 'OPEN';
    fixture.viewError = mode === 'unreadable';
    expect(await mergePR(sandbox.repo, 42, { expectedHeadSha: head })).toMatchObject({ success: false,
      branchCleanup: { deleted: false, reason: 'merge-unverified' } });
    expect(await remoteHead()).toBe(head);
    await expectLocalEvidence();
  });

  it('guards the shared core even if a checkout-mode caller requests deletion', async () => {
    await runForgeMerge({ cwd: sandbox.repo, forge: 'github', number: 42, deleteBranch: true, expectedHeadSha: head });
    await expectLocalEvidence();
    expect(await remoteHead()).toBe(head);
    expect(execGh.mock.calls[0][0]).not.toContain('--delete-branch');
  });
});
