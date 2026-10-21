import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execGit } from '../lib/execGit.js';
import { releaseOwnerlessForeignHolder } from './worktreeManager.js';

// Real git: the guard's whole job is reading real repo state before it detaches
// a tree PortOS did not create.
const BRANCH = 'chore/leftover';
const free = async () => false;

let root, repo, holder;
const git = (args, cwd = repo) => execGit(args, cwd).then(r => r.stdout.trim());
const holderBranch = () => git(['branch', '--show-current'], holder);
const release = (extra = {}) => releaseOwnerlessForeignHolder(repo, BRANCH, { agents: [], hasProcessInside: free, ...extra });

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  root = await realpath(await mkdtemp(join(tmpdir(), 'release-ownerless-')));
  const remote = join(root, 'remote.git');
  repo = join(root, 'repo');
  holder = join(root, 'wt-leftover');
  await git(['init', '--bare', '-b', 'main', remote], root);
  await git(['init', '-b', 'main', repo], root);
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) await git(['config', k, v]);
  await git(['remote', 'add', 'origin', remote]);
  await git(['commit', '--allow-empty', '-m', 'init']);
  await git(['push', '-q', '-u', 'origin', 'main']);
  await git(['worktree', 'add', '-q', '-b', BRANCH, holder, 'main']);
  await git(['commit', '--allow-empty', '-m', 'work'], holder);
  await git(['push', '-q', '-u', 'origin', BRANCH], holder);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('releaseOwnerlessForeignHolder', () => {
  it('detaches a clean, pushed, ownerless foreign tree in place so the branch can be attached at once', async () => {
    const released = await release();
    expect(resolve(released.path)).toBe(resolve(holder));
    expect(existsSync(holder)).toBe(true);
    expect(await holderBranch()).toBe('');
    await git(['worktree', 'add', '-q', join(root, 'follow-up'), BRANCH]);
  });

  it('ignores git-ignored caches', async () => {
    await writeFile(join(holder, '.gitignore'), 'cache/\n');
    await git(['add', '.gitignore'], holder);
    await git(['commit', '-q', '-m', 'ignore'], holder);
    await git(['push', '-q'], holder);
    await mkdir(join(holder, 'cache'));
    await writeFile(join(holder, 'cache', 'x'), '1');
    expect(await release()).not.toBeNull();
    expect(existsSync(join(holder, 'cache', 'x'))).toBe(true);
  });

  it.each([
    ['an untracked file', async () => writeFile(join(holder, 'notes.txt'), 'draft')],
    ['a staged change', async () => { await writeFile(join(holder, 't.txt'), 'v'); await git(['add', 't.txt'], holder); }],
    ['an unpushed commit', async () => git(['commit', '--allow-empty', '-m', 'local'], holder)],
  ])('refuses a holder with %s', async (_label, dirty) => {
    await dirty();
    await expect(release()).resolves.toBeNull();
    expect(await holderBranch()).toBe(BRANCH);
  });

  it('refuses when a process may be inside the tree, including a probe that throws', async () => {
    await expect(release({ hasProcessInside: async () => true })).resolves.toBeNull();
    await expect(release({ hasProcessInside: async () => { throw new Error('lsof missing'); } })).resolves.toBeNull();
    expect(await holderBranch()).toBe(BRANCH);
  });

  it('refuses when the agent registry is unreadable or a live agent workspace is in the tree', async () => {
    await expect(release({ agents: null })).resolves.toBeNull();
    await expect(release({ activeWorkspacePaths: [join(holder, 'sub')] })).resolves.toBeNull();
    expect(await holderBranch()).toBe(BRANCH);
  });

  it('refuses a locked holder, the primary checkout and a protected branch', async () => {
    await git(['worktree', 'lock', holder]);
    await expect(release()).resolves.toBeNull();
    await git(['worktree', 'unlock', holder]);
    await expect(releaseOwnerlessForeignHolder(repo, 'main', { agents: [], hasProcessInside: free })).resolves.toBeNull();
    await git(['checkout', '-q', '-b', 'feature/primary']);
    await expect(releaseOwnerlessForeignHolder(repo, 'feature/primary', { agents: [], hasProcessInside: free })).resolves.toBeNull();
    expect(await git(['branch', '--show-current'])).toBe('feature/primary');
  });
});
