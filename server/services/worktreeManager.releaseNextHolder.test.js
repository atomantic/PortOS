import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execGit } from '../lib/execGit.js';
import { releaseIdleSiblingNextHolder } from './worktreeManager.js';

// Real git, because the guard's whole job is reading real repo state (porcelain,
// upstream ancestry, git-dir mtimes) before it detaches someone's tree.
const BRANCH = 'next/issue-1';
const LATER = () => Date.now() + 60 * 60 * 1000;

let root, repo, holder;
const git = (args, cwd = repo) => execGit(args, cwd).then(r => r.stdout.trim());
const holderBranch = () => git(['branch', '--show-current'], holder);

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  root = await realpath(await mkdtemp(join(tmpdir(), 'release-next-')));
  const remote = join(root, 'remote.git');
  repo = join(root, 'repo');
  holder = join(root, 'next-issue-1');
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

describe('releaseIdleSiblingNextHolder', () => {
  it('detaches an idle, clean, pushed sibling tree in place so the branch can be checked out', async () => {
    // git reports forward-slash paths on Windows, so compare resolved paths.
    const released = await releaseIdleSiblingNextHolder(repo, BRANCH, { nowMs: LATER() });
    expect(resolve(released.path)).toBe(resolve(holder));
    expect(existsSync(holder)).toBe(true);
    expect(await holderBranch()).toBe('');
    await git(['worktree', 'add', '-q', join(root, 'follow-up'), BRANCH]);
  });

  it('refuses a tree with a commit that exists only locally', async () => {
    await git(['commit', '--allow-empty', '-m', 'unpushed'], holder);
    await expect(releaseIdleSiblingNextHolder(repo, BRANCH, { nowMs: LATER() })).resolves.toBeNull();
    expect(await holderBranch()).toBe(BRANCH);
  });

  it('refuses a tree with an untracked file', async () => {
    await writeFile(join(holder, 'notes.txt'), 'draft');
    await expect(releaseIdleSiblingNextHolder(repo, BRANCH, { nowMs: LATER() })).resolves.toBeNull();
    expect(await holderBranch()).toBe(BRANCH);
  });

  it('refuses a tree touched within the idle window', async () => {
    await expect(releaseIdleSiblingNextHolder(repo, BRANCH)).resolves.toBeNull();
    expect(await holderBranch()).toBe(BRANCH);
  });

  it('refuses a tree a running agent works in', async () => {
    await expect(releaseIdleSiblingNextHolder(repo, BRANCH, { nowMs: LATER(), activeWorkspacePaths: [holder] })).resolves.toBeNull();
    expect(await holderBranch()).toBe(BRANCH);
  });

  it('never touches the primary checkout or a non-/do:next branch', async () => {
    await git(['switch', '-q', '--detach'], holder);
    await git(['switch', '-q', BRANCH]);
    await expect(releaseIdleSiblingNextHolder(repo, BRANCH, { nowMs: LATER() })).resolves.toBeNull();
    expect(await git(['branch', '--show-current'])).toBe(BRANCH);
    await expect(releaseIdleSiblingNextHolder(repo, 'feature/x', { nowMs: LATER() })).resolves.toBeNull();
  });
});
