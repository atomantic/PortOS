import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from './execGit.js';
import {
  makeGitSandbox,
  attachBareOrigin,
  materializeGitRepo,
  destroyGitSandbox,
  resetGitSandbox,
  resetGitWorktreeSandbox,
} from './gitTestRepo.js';

describe('template exit hook', () => {
  it('registers a single process-exit listener across module re-imports', async () => {
    // First sandbox builds the worker template and should arm the hook.
    const box = await makeGitSandbox({ prefix: 'portos-git-fx-hook-' });
    sandboxes.push(box.scratch);
    const before = process.listenerCount('exit');
    // A second build in this same module uses the cached template promise
    // and must not add another listener. The watch-mode case (fresh module
    // cache) is the same function: rememberTemplate no-ops once hooked.
    const box2 = await makeGitSandbox({ prefix: 'portos-git-fx-hook2-' });
    sandboxes.push(box2.scratch);
    expect(process.listenerCount('exit')).toBe(before);
    expect(globalThis.__portosGitTemplateExitHooked).toBe(true);
    expect(Array.isArray(globalThis.__portosGitTemplateDirs)).toBe(true);
    expect(globalThis.__portosGitTemplateDirs.length).toBeGreaterThan(0);
  });
});

const sandboxes = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => destroyGitSandbox(s)));
});

describe('makeGitSandbox', () => {
  it('yields a real repo on main with the template commit and no origin by default', async () => {
    const box = await makeGitSandbox({ prefix: 'portos-git-fx-' });
    sandboxes.push(box.scratch);
    expect((await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], box.repo)).stdout.trim()).toBe('main');
    expect((await execGit(['log', '-1', '--pretty=%s'], box.repo)).stdout.trim()).toBe('initial');
    const remotes = (await execGit(['remote'], box.repo)).stdout.trim();
    expect(remotes).toBe('');
  });

  it('rewrites origin to the sandbox copy so two sandboxes cannot share a remote', async () => {
    const a = await makeGitSandbox({ origin: true, prefix: 'portos-git-fx-a-' });
    const b = await makeGitSandbox({ origin: true, prefix: 'portos-git-fx-b-' });
    sandboxes.push(a.scratch, b.scratch);

    const urlA = (await execGit(['remote', 'get-url', 'origin'], a.repo)).stdout.trim();
    const urlB = (await execGit(['remote', 'get-url', 'origin'], b.repo)).stdout.trim();
    expect(urlA).toBe(a.origin);
    expect(urlB).toBe(b.origin);
    expect(urlA).not.toBe(urlB);

    await writeFile(join(a.repo, 'only-a.txt'), 'a');
    await execGit(['add', '-A'], a.repo);
    await execGit(['commit', '-m', 'only a'], a.repo);
    await execGit(['push', 'origin', 'main'], a.repo);

    const inB = await execGit(['cat-file', '-e', 'origin/main:only-a.txt'], b.repo, { ignoreExitCode: true });
    expect(inB.exitCode).not.toBe(0);
  });
});

describe('attachBareOrigin / materializeGitRepo', () => {
  it('publishes commits made before the origin was attached', async () => {
    const box = await makeGitSandbox({ prefix: 'portos-git-fx-att-' });
    sandboxes.push(box.scratch);
    await writeFile(join(box.repo, 'ahead.txt'), 'ahead');
    await execGit(['add', '-A'], box.repo);
    await execGit(['commit', '-m', 'ahead of origin'], box.repo);

    const origin = await attachBareOrigin(box.scratch, box.repo);
    expect(existsSync(origin)).toBe(true);
    expect((await execGit(['log', '-1', '--pretty=%s', 'origin/main'], box.repo)).stdout.trim())
      .toBe('ahead of origin');
  });

  it('fills an existing directory as a standalone repo root', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'portos-git-fx-mat-'));
    sandboxes.push(dest);
    await materializeGitRepo(dest, { identity: { email: 'test@example.com', name: 'Test' } });
    const top = (await execGit(['rev-parse', '--show-toplevel'], dest)).stdout.trim();
    expect(top).toBeTruthy();
    expect((await execGit(['log', '-1', '--pretty=%s'], dest)).stdout.trim()).toBe('initial');
    expect((await execGit(['config', 'user.email'], dest)).stdout.trim()).toBe('test@example.com');
  });
});

describe('resetGitSandbox', () => {
  it('discards branches, commits, the origin remote, and scratch siblings back to the initial state', async () => {
    const box = await makeGitSandbox({ prefix: 'portos-git-fx-reset-' });
    sandboxes.push(box.scratch);
    const initialHead = (await execGit(['rev-parse', 'HEAD'], box.repo)).stdout.trim();

    await attachBareOrigin(box.scratch, box.repo);
    await execGit(['checkout', '-b', 'feature'], box.repo);
    await writeFile(join(box.repo, 'work.txt'), 'wip');
    await execGit(['add', '-A'], box.repo);
    await execGit(['commit', '-m', 'feature work'], box.repo);
    await writeFile(join(box.repo, 'untracked.txt'), 'scratch');

    await resetGitSandbox({ scratch: box.scratch, repo: box.repo, initialHead });

    expect((await execGit(['rev-parse', 'HEAD'], box.repo)).stdout.trim()).toBe(initialHead);
    expect((await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], box.repo)).stdout.trim()).toBe('main');
    const branches = (await execGit(['branch', '--format=%(refname:short)'], box.repo)).stdout.trim();
    expect(branches).toBe('main');
    expect((await execGit(['remote'], box.repo)).stdout.trim()).toBe('');
    expect(existsSync(join(box.repo, 'untracked.txt'))).toBe(false);
    const scratchEntries = await readdir(box.scratch);
    expect(scratchEntries).toEqual(['primary']);
  });

  it('is safe to call on a plain repo with no scratch wrapper', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'portos-git-fx-reset-plain-'));
    sandboxes.push(dest);
    await materializeGitRepo(dest);
    const initialHead = (await execGit(['rev-parse', 'HEAD'], dest)).stdout.trim();
    await execGit(['checkout', '-b', 'wip'], dest);
    await writeFile(join(dest, 'work.txt'), 'wip');
    await execGit(['add', '-A'], dest);
    await execGit(['commit', '-m', 'wip'], dest);

    await resetGitSandbox({ repo: dest, initialHead });

    expect((await execGit(['rev-parse', 'HEAD'], dest)).stdout.trim()).toBe(initialHead);
    expect((await execGit(['branch', '--format=%(refname:short)'], dest)).stdout.trim()).toBe('main');
  });

  it('checks assertPath instead of repo when a caller passes a respelled repo path', async () => {
    // Simulates a `repo` that's git's own respelling of an mkdtemp() path
    // (worktreeReap.test.js's initRepo() does this via `rev-parse
    // --show-toplevel`) — on Windows that spelling can disagree with
    // os.tmpdir()'s own (8.3 short form vs git's long form), which
    // assertTempPath's realpath-based check cannot bridge (#6003).
    const dest = await mkdtemp(join(tmpdir(), 'portos-git-fx-reset-assertpath-'));
    sandboxes.push(dest);
    await materializeGitRepo(dest);
    const initialHead = (await execGit(['rev-parse', 'HEAD'], dest)).stdout.trim();
    const respelled = (await execGit(['rev-parse', '--show-toplevel'], dest)).stdout.trim();

    // repo=respelled would still resolve to the real directory (git's
    // respelling is never actually outside tmpdir — this only stands in for
    // the case where an OS spelling mismatch would make it look that way to
    // assertTempPath) — the point is that passing assertPath overrides which
    // string gets checked, without changing which directory git operates on.
    await resetGitSandbox({ repo: respelled, initialHead, assertPath: dest });

    expect((await execGit(['rev-parse', 'HEAD'], dest)).stdout.trim()).toBe(initialHead);
  });

  it('rejects an unsafe assertPath even when repo itself is a real temp dir', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'portos-git-fx-reset-unsafe-'));
    sandboxes.push(dest);
    await materializeGitRepo(dest);
    const initialHead = (await execGit(['rev-parse', 'HEAD'], dest)).stdout.trim();

    await expect(resetGitSandbox({ repo: dest, initialHead, assertPath: '/etc' }))
      .rejects.toThrow(/refusing to run/);
  });
});

describe('resetGitWorktreeSandbox', () => {
  it('removes every worktree it grew, including a locked one, and restores main', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'portos-git-fx-reset-wt-'));
    sandboxes.push(dest);
    await materializeGitRepo(dest);
    const initialHead = (await execGit(['rev-parse', 'HEAD'], dest)).stdout.trim();

    const wtA = await mkdtemp(join(tmpdir(), 'portos-git-fx-reset-wt-a-'));
    const wtB = await mkdtemp(join(tmpdir(), 'portos-git-fx-reset-wt-b-'));
    sandboxes.push(wtA, wtB);
    await execGit(['worktree', 'add', '-b', 'wt-a', wtA, 'main'], dest);
    await execGit(['worktree', 'add', '-b', 'wt-b', wtB, 'main'], dest);
    await execGit(['worktree', 'lock', wtB], dest);

    await resetGitWorktreeSandbox(dest, initialHead);

    // Parse porcelain into worktree entries and assert only `dest` itself
    // remains, rather than substring-matching 'wt-a'/'wt-b' against the raw
    // listing — that substring can coincidentally appear inside dest's own
    // random mkdtemp() suffix (~3.2% chance per prefix) and false-fail (#6059).
    // Counting entries also sidesteps comparing absolute paths directly,
    // which git can respell on Windows (see the assertPath test above, #6003).
    const listing = (await execGit(['worktree', 'list', '--porcelain'], dest)).stdout;
    const worktreeEntries = listing.split(/\r?\n/).filter((line) => line.startsWith('worktree '));
    expect(worktreeEntries).toHaveLength(1);
    expect((await execGit(['branch', '--format=%(refname:short)'], dest)).stdout.trim()).toBe('main');
    expect((await execGit(['rev-parse', 'HEAD'], dest)).stdout.trim()).toBe(initialHead);
  });
});
