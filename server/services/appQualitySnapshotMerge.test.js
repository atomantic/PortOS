// Real git: snapshot checkouts stay when ignored or untracked local content
// cannot be proved disposable, even after their PR merges.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { destroyGitSandbox, makeGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { retireSnapshotMergeCheckouts } from './appQualitySnapshotMerge.js';

const pr = { url: 'https://github.com/example/repo/pull/7' };
const admitted = { checkSnapshotPublicationOwnership: async () => ({ admitted: true }) };

describe.skipIf(SKIP_HEAVY_INTEGRATION)('retireSnapshotMergeCheckouts', () => {
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

  it('retains unverified ignored validation output in a merged snapshot checkout', async () => {
    const path = await snapshotCheckout('clean');
    const held = await retireSnapshotMergeCheckouts({ id: 'app', repoPath: sandbox.repo }, pr, admitted);
    expect(held).toHaveLength(1);
    expect(existsSync(join(path, '.cache', 'pregate', 'report.json'))).toBe(true);
  });

  it('keeps a snapshot checkout with untracked work', async () => {
    const path = await snapshotCheckout('dirty');
    await writeFile(join(path, 'wanted.txt'), 'local work');
    const held = await retireSnapshotMergeCheckouts({ id: 'app', repoPath: sandbox.repo }, pr, admitted);
    expect(held).toHaveLength(1);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'wanted.txt'))).toBe(true);
  });
});
