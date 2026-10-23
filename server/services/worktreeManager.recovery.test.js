import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot, mockTestIdentity, ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const diagnostics = vi.hoisted(() => ({ commands: new Map(), pending: new Set() }));
vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  const observe = run => async (args, ...rest) => {
    const command = args[1]?.startsWith('-') || ['worktree', 'bundle', 'remote'].includes(args[0])
      ? args.slice(0, 2).join(' ') : args[0];
    const started = performance.now();
    const pending = { command, started };
    diagnostics.pending.add(pending);
    try { return await run(args, ...rest); }
    finally {
      diagnostics.pending.delete(pending);
      const row = diagnostics.commands.get(command) || { count: 0, ms: 0, maxMs: 0 };
      const elapsed = performance.now() - started;
      row.count++;
      row.ms += elapsed;
      row.maxMs = Math.max(row.maxMs, elapsed);
      diagnostics.commands.set(command, row);
    }
  };
  return { ...actual, execGit: observe(actual.execGit), execGitSafe: observe(actual.execGitSafe) };
});
let activePhase;
let phaseStarted;
function phase(name) {
  const now = performance.now();
  if (activePhase) console.log(`⏱️ Recovery ${activePhase}: ${Math.round(now - phaseStarted)}ms`);
  activePhase = name;
  phaseStarted = now;
  console.log(`⏱️ Recovery starting ${name}`);
}
beforeEach(async () => {
  await drain();
  diagnostics.commands.clear();
  diagnostics.pending.clear();
  activePhase = null;
});
afterEach(() => {
  if (activePhase) console.log(`⏱️ Recovery last phase ${activePhase}: ${Math.round(performance.now() - phaseStarted)}ms`);
  const commands = [...diagnostics.commands].sort((a, b) => b[1].ms - a[1].ms);
  console.log(`⏱️ Recovery Git: ${commands.reduce((total, [, row]) => total + row.count, 0)} calls`);
  for (const [name, row] of commands.slice(0, 5)) {
    console.log(`⏱️ Git ${name}: ${row.count} calls, ${Math.round(row.ms)}ms total, ${Math.round(row.maxMs)}ms max`);
  }
  for (const { command, started } of diagnostics.pending) {
    console.log(`⏱️ Pending Git ${command}: ${Math.round(performance.now() - started)}ms`);
  }
});

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-worktree-recovery-' });
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('../lib/paths.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
const { PATHS } = await import('../lib/fileUtils.js');
const { removeWorktree, adoptWorktree, createWorktree } = await import('./worktreeManager.js');
const { it, drain } = ownTestBodies(vitestIt);
afterAll(async () => { try { await drain(); } finally { cleanup(); } });

describe.skipIf(SKIP_HEAVY_INTEGRATION)('failed worktree cleanup recovery', () => {
  let fixture;
  let sequence = 0;
  const options = { merge: false, preserveBranchWithCommits: true };
  beforeAll(async () => {
    await mkdir(PATHS.worktrees, { recursive: true });
    await writeFile(join(PATHS.cos, 'state.json'), JSON.stringify({ agents: {} }));
  });
  beforeEach(async () => {
    phase('fixture');
    const agentId = `agent-recovery-${++sequence}`;
    const repo = join(tempRoot, `${agentId}-source`);
    await materializeGitRepo(repo);
    const branch = `cos/recovery/${agentId}`;
    const worktree = join(PATHS.worktrees, agentId);
    await execGit(['worktree', 'add', '-b', branch, worktree, 'main'], repo);
    await writeFile(join(worktree, 'recoverable.txt'), 'unpublished agent work\n');
    await execGit(['add', 'recoverable.txt'], worktree);
    await execGit(['commit', '-m', 'unpublished work'], worktree);
    fixture = { repo, branch, worktree, agentId };
  });

  // Each case owns a distinct recovery contract and a fresh repository. Keeping
  // five cleanup callbacks in one body made Git launch latency exhaust its budget.
  it('retains unpublished work across repeated cleanup callbacks', async () => {
    const { repo, branch, worktree, agentId } = fixture;
    for (let attempt = 0; attempt < 2; attempt++) {
      phase(`unpublished callback ${attempt + 1}`);
      expect(await removeWorktree(agentId, repo, branch, options)).toMatchObject({
        removed: false, warnings: expect.arrayContaining([expect.stringContaining('merge-evidence-unavailable')]),
      });
      expect(await readFile(join(worktree, 'recoverable.txt'), 'utf8')).toBe('unpublished agent work\n');
    }
  });

  it('recovers an unpublished branch after an earlier workflow removed its checkout', async () => {
    const { repo, branch, worktree, agentId } = fixture;
    // Older workflows removed the checkout before preserving its branch. Model
    // that already-completed removal only inside this disposable repository.
    phase('legacy checkout removal');
    await execGit(['worktree', 'remove', worktree], repo);
    phase('missing checkout callback');
    expect(await removeWorktree(agentId, repo, branch, options)).toMatchObject({
      removed: true, warnings: expect.arrayContaining([expect.stringContaining('merge evidence was not established')]),
    });

    // A retry can attach a new checkout and read the authored file, without
    // reflog surgery or a remote branch that the failed run never pushed.
    const resumed = join(PATHS.worktrees, 'agent-retry');
    phase('reattach');
    await expect(execGit(['worktree', 'add', resumed, branch], repo)).resolves.toMatchObject({ exitCode: 0 });
    expect((await execGit(['show', 'HEAD:recoverable.txt'], resumed)).stdout).toBe('unpublished agent work\n');
  });

  it('retires a merged recovery idempotently and preserves its reflog and commit bundle', async () => {
    const { repo, branch, agentId } = fixture;
    // Once recovered work lands, both its first cleanup and any later completion
    // callback must report success without inventing a preserved branch.
    phase('merge');
    await execGit(['merge', branch, '--no-edit'], repo);
    const reflog = await readFile(join(repo, '.git', 'logs', 'refs', 'heads', ...branch.split('/')));
    phase('merged checkout retirement');
    expect(await removeWorktree(agentId, repo, branch, options)).toMatchObject({ removed: true, warnings: [] });
    phase('repeated merged callback');
    expect(await removeWorktree(agentId, repo, branch, options)).toMatchObject({ removed: true, warnings: [] });
    phase('preservation assertions');
    const archiveRoot = join(PATHS.cos, 'branch-retirement-archives');
    const archives = await readdir(archiveRoot);
    expect(archives).toHaveLength(1);
    expect(await readFile(join(archiveRoot, archives[0], 'reflog'))).toEqual(reflog);
    await expect(execGit(['bundle', 'verify', join(archiveRoot, archives[0], 'commits.bundle')], repo))
      .resolves.toMatchObject({ exitCode: 0 });
    expect((await execGit(['show-ref', '--verify', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('partial removal adoption safety', () => {
  it('preserves a damaged checkout and occupied branch, then permits recovery with ordinary edits', async () => {
    phase('partial fixture');
    const repo = join(tempRoot, 'partial-source');
    await materializeGitRepo(repo);
    const files = Array.from({ length: 120 }, (_, i) => `tracked-${i}.txt`);
    await Promise.all(files.map(file => writeFile(join(repo, file), 'original\n')));
    await execGit(['add', '.'], repo);
    await execGit(['commit', '-m', 'tracked fixture'], repo);
    await mkdir(PATHS.worktrees, { recursive: true });
    const branch = 'cos/partial/agent-partial';
    const worktree = join(PATHS.worktrees, 'agent-partial');
    const target = join(PATHS.worktrees, 'agent-partial-retry');
    await execGit(['worktree', 'add', '-b', branch, worktree, 'main'], repo);
    await Promise.all(files.slice(0, 105).map(file => rm(join(worktree, file))));
    await writeFile(join(worktree, 'tracked-119.txt'), 'authored edit\n');
    await writeFile(join(worktree, 'draft.txt'), 'authored draft\n');
    const status = (await execGit(['status', '--porcelain'], worktree)).stdout;
    const head = (await execGit(['rev-parse', branch], repo)).stdout;
    const registrations = (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout;

    phase('damaged checkout refusal');
    expect(await adoptWorktree('agent-partial-retry', repo, worktree, branch)).toBeNull();
    expect(existsSync(target)).toBe(false);
    expect((await execGit(['status', '--porcelain'], worktree)).stdout).toBe(status);
    expect((await execGit(['rev-parse', branch], repo)).stdout).toBe(head);
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).toBe(registrations);
    // The caller's fresh-tree fallback must fail closed on the still-held branch;
    // it cannot detach the damaged checkout or reset its branch to get unstuck.
    phase('occupied branch refusal');
    await expect(createWorktree('agent-partial-retry', repo, 'task-partial', { existingBranch: branch }))
      .rejects.toThrow(/already (?:checked out|used by worktree)/);
    expect(existsSync(target)).toBe(false);
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).toBe(registrations);
    expect(await readFile(join(worktree, 'draft.txt'), 'utf8')).toBe('authored draft\n');

    // Explicit recovery restores only the simulated accidental deletions. One
    // authored deletion plus the tracked edit and untracked draft still resume.
    phase('restore and adopt');
    await execGit(['restore', '--', ...files.slice(1, 105)], worktree);
    const recoveredStatus = (await execGit(['status', '--porcelain'], worktree)).stdout;
    expect(await adoptWorktree('agent-partial-retry', repo, worktree, branch)).toMatchObject({ adopted: true, worktreePath: target });
    expect((await execGit(['status', '--porcelain'], target)).stdout).toBe(recoveredStatus);
    expect(await readFile(join(target, 'tracked-119.txt'), 'utf8')).toBe('authored edit\n');
    expect(await readFile(join(target, 'draft.txt'), 'utf8')).toBe('authored draft\n');
  });
});
