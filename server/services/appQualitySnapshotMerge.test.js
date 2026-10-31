// Real git: a merged snapshot checkout is retired even with ignored output, but
// untracked (non-ignored) work still holds it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { destroyGitSandbox, makeGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { sweepSettledSnapshotCheckouts } from './appQualitySnapshotMerge.js';

const pr = { url: 'https://github.com/example/repo/pull/7' };
const admitted = { checkSnapshotPublicationOwnership: async () => ({ admitted: true }) };
const mergedForge = { ...admitted, resolveForgeForRepo: async () => ({ cli: 'gh', env: {} }),
  execGh: async () => JSON.stringify({ state: 'MERGED' }) };

describe.skipIf(SKIP_HEAVY_INTEGRATION)('sweepSettledSnapshotCheckouts', () => {
  let sandbox;
  beforeEach(async () => { sandbox = await makeGitSandbox({ prefix: 'portos-quality-merge-' }); });
  afterEach(async () => { await destroyGitSandbox(sandbox.scratch); });

  async function snapshotCheckout(name) {
    const path = join(sandbox.scratch, `portos-quality-${name}`);
    await execGit(['worktree', 'add', '--detach', path, 'HEAD'], sandbox.repo);
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    await writeFile(join(sandbox.repo, '.git', 'info', 'exclude'), '.cache/\n');
    await mkdir(join(path, '.cache', 'pregate'), { recursive: true });
    await writeFile(join(path, '.cache', 'quality-snapshot-merge.json'), JSON.stringify({ prUrl: pr.url, checkoutHead: head }));
    await writeFile(join(path, '.cache', 'pregate', 'report.json'), '{"passed":true}');
    return path;
  }

  it('retires a clean merged snapshot checkout holding only its receipt and validation report', async () => {
    const path = await snapshotCheckout('clean');
    const swept = await sweepSettledSnapshotCheckouts({ id: 'app', repoPath: sandbox.repo }, {}, mergedForge);
    expect(swept).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  });

  it('retires a merged snapshot checkout holding other ignored output', async () => {
    const path = await snapshotCheckout('ignored');
    await writeFile(join(path, '.cache', 'unique-output.bin'), 'only copy');
    const swept = await sweepSettledSnapshotCheckouts({ id: 'app', repoPath: sandbox.repo }, {}, mergedForge);
    expect(swept).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps a snapshot checkout with untracked work', async () => {
    const path = await snapshotCheckout('dirty');
    await writeFile(join(path, 'wanted.txt'), 'local work');
    expect(await sweepSettledSnapshotCheckouts({ id: 'app', repoPath: sandbox.repo }, {}, mergedForge)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'wanted.txt'))).toBe(true);
  });

  it('sweeps checkouts of settled PRs and keeps those of open PRs', async () => {
    const make = async (name, prUrl) => {
      const path = join(sandbox.scratch, `portos-quality-${name}`);
      await execGit(['worktree', 'add', '--detach', path, 'HEAD'], sandbox.repo);
      const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      await writeFile(join(sandbox.repo, '.git', 'info', 'exclude'), '.cache/\n');
      await mkdir(join(path, '.cache'), { recursive: true });
      await writeFile(join(path, '.cache', 'quality-snapshot-merge.json'), JSON.stringify({ prUrl, checkoutHead: head }));
      return path;
    };
    const merged = await make('merged', 'https://github.com/example/repo/pull/1');
    const open = await make('open', 'https://github.com/example/repo/pull/2');
    const deps = {
      ...admitted,
      resolveForgeForRepo: async () => ({ cli: 'gh', env: {} }),
      execGh: async args => JSON.stringify({ state: args[2].endsWith('/1') ? 'MERGED' : 'OPEN' }),
    };
    const swept = await sweepSettledSnapshotCheckouts({ id: 'app', repoPath: sandbox.repo }, {}, deps);
    expect(swept.map(p => basename(p))).toEqual([basename(merged)]);
    expect(existsSync(merged)).toBe(false);
    expect(existsSync(open)).toBe(true);
  });

  it('sweeps past a drifted checkout instead of aborting', async () => {
    const make = async (name, prUrl, checkoutHead) => {
      const path = join(sandbox.scratch, `portos-quality-${name}`);
      await execGit(['worktree', 'add', '--detach', path, 'HEAD'], sandbox.repo);
      const head = checkoutHead || (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      await writeFile(join(sandbox.repo, '.git', 'info', 'exclude'), '.cache/\n');
      await mkdir(join(path, '.cache'), { recursive: true });
      await writeFile(join(path, '.cache', 'quality-snapshot-merge.json'), JSON.stringify({ prUrl, checkoutHead: head }));
      return path;
    };
    const drifted = await make('drifted', 'https://github.com/example/repo/pull/2', 'f'.repeat(40));
    const merged = await make('merged', 'https://github.com/example/repo/pull/1');
    const deps = {
      ...admitted,
      resolveForgeForRepo: async () => ({ cli: 'gh', env: {} }),
      execGh: async () => JSON.stringify({ state: 'MERGED' }),
    };
    const swept = await sweepSettledSnapshotCheckouts({ id: 'app', repoPath: sandbox.repo }, {}, deps);
    expect(swept.map(p => basename(p))).toEqual([basename(merged)]);
    expect(existsSync(drifted)).toBe(true);
  });
});
