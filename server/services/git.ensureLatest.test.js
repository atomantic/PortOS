import { describe, it, expect, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { ensureLatest } from './git.js';

// Real git: the regressions here are git's own on-disk rebase state
// (`.git/rebase-merge`) and what `reset`/`rebase --abort` do to it.
describe.skipIf(SKIP_HEAVY_INTEGRATION)('ensureLatest on a diverged checkout', () => {
  let sandbox;
  afterEach(async () => { if (sandbox) await destroyGitSandbox(sandbox.scratch); sandbox = null; });

  const commitFile = async (repo, file, body, msg) => {
    await writeFile(join(repo, file), body);
    await execGit(['add', file], repo);
    await execGit(['commit', '-m', msg], repo);
  };

  // origin and the local checkout each commit a different body to `file`.
  const diverge = async (file) => {
    sandbox = await makeGitSandbox({ origin: true });
    const { scratch, repo, origin } = sandbox;
    await execGit(['push', '-u', 'origin', 'main'], repo, { ignoreExitCode: true });
    const other = join(scratch, 'other');
    await execGit(['clone', origin, other], scratch);
    await execGit(['config', 'user.email', 'agent@example.com'], other);
    await execGit(['config', 'user.name', 'Example Agent'], other);
    await commitFile(other, file, '{"from":"origin"}\n', 'origin change');
    await execGit(['push', 'origin', 'HEAD:main'], other);
    await commitFile(repo, file, '{"from":"local"}\n', 'local change');
    return repo;
  };

  const rebaseDirExists = (repo) => existsSync(join(repo, '.git', 'rebase-merge'));

  it('serializes concurrent pulls so neither trips over (or aborts) the other\'s rebase', async () => {
    const repo = await diverge('notes.txt');
    const results = await Promise.all([ensureLatest(repo), ensureLatest(repo), ensureLatest(repo)]);
    for (const r of results) {
      expect(r.conflict).toBe(true);
      expect(r.error).not.toMatch(/rebase-merge directory/);
      expect(r.error).not.toMatch(/hint:/);
      expect(r.error).toMatch(/CONFLICT|could not apply/);
    }
    expect(rebaseDirExists(repo)).toBe(false);
  });

  it('drops local commits that only touch PortOS-owned .quality.json and lands on origin', async () => {
    const repo = await diverge('.quality.json');
    const r = await ensureLatest(repo);
    expect(r).toMatchObject({ success: true, conflict: false });
    expect(r.droppedLocalCommits).toHaveLength(1);
    const head = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const upstream = (await execGit(['rev-parse', 'origin/main'], repo)).stdout.trim();
    expect(head).toBe(upstream);
  });

  it('keeps local commits that touch anything besides PortOS-owned files', async () => {
    const repo = await diverge('.quality.json');
    await commitFile(repo, 'src.txt', 'user work\n', 'user work');
    const before = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const r = await ensureLatest(repo);
    expect(r.conflict).toBe(true);
    expect((await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim()).toBe(before);
  });

  it('leaves someone else\'s in-progress rebase alone', async () => {
    const repo = await diverge('notes.txt');
    await execGit(['fetch', 'origin'], repo);
    await execGit(['rebase', 'origin/main'], repo, { ignoreExitCode: true });
    expect(rebaseDirExists(repo)).toBe(true);
    const r = await ensureLatest(repo);
    expect(r.conflict).toBe(true);
    expect(r.error).toMatch(/already in progress/);
    expect(rebaseDirExists(repo)).toBe(true);
  });
});
