import { mkdtemp, readdir, utimes, writeFile } from 'fs/promises';
import { realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { sweepStaleDoneSentinels, checkoutDirsOf, STALE_SENTINEL_MIN_AGE_MS } from './agentSentinelSweep.js';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

const tempRoots = [];
let dir;

/** Write a file and back-date it so the sweep's age floor is satisfied. */
async function writeAged(name, ageMs) {
  const target = join(dir, name);
  await writeFile(target, 'summary');
  const when = new Date(Date.now() - ageMs);
  await utimes(target, when, when);
  return target;
}

const OLD = STALE_SENTINEL_MIN_AGE_MS * 2;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sentinel-sweep-'));
  tempRoots.push(dir);
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sweepStaleDoneSentinels', () => {
  it('removes an abandoned sentinel whose agent is gone, and nothing else', async () => {
    await writeAged('.agent-done-agent-dead', OLD);
    await writeAged('README.md', OLD);
    // `.agent-doneish` has no separator, so it is not a sentinel at all —
    // unlike `.agent-done-ish`, which is exactly what agent id `ish` produces.
    await writeAged('.agent-doneish', OLD);

    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['.agent-doneish', 'README.md']);
  });

  it('keeps the sentinel of an agent that has not finished', async () => {
    await writeAged('.agent-done-agent-live', OLD);

    expect(await sweepStaleDoneSentinels([dir], new Set(['agent-live']))).toBe(0);
    expect(await readdir(dir)).toEqual(['.agent-done-agent-live']);
  });

  it('keeps a fresh sentinel — a run may not be registered yet', async () => {
    await writeAged('.agent-done-agent-new', 1000);

    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(0);
    expect(await readdir(dir)).toEqual(['.agent-done-agent-new']);
  });

  it('removes the bare unscoped sentinel only once it is old', async () => {
    await writeAged('.agent-done', 1000);
    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(0);

    await writeAged('.agent-done', OLD);
    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes nothing when liveness is unknown', async () => {
    await writeAged('.agent-done-agent-dead', OLD);

    expect(await sweepStaleDoneSentinels([dir], null)).toBe(0);
    expect(await readdir(dir)).toEqual(['.agent-done-agent-dead']);
  });

  it('skips unreadable or missing directories instead of throwing', async () => {
    await writeAged('.agent-done-agent-dead', OLD);

    expect(await sweepStaleDoneSentinels([join(dir, 'nope'), dir, null, ''], new Set())).toBe(1);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('sweeping a repo\'s linked worktrees', () => {
  it('removes a stale sentinel stranded in a linked worktree and leaves a live run\'s alone', async () => {
    const repo = join(dir, 'repo');
    await materializeGitRepo(repo, { identity: { email: 'test@example.com', name: 'Test' } });
    const tree = join(dir, 'linked');
    await execGit(['worktree', 'add', '-b', 'feature/done', tree, 'main'], repo);
    for (const name of ['.agent-done-agent-dead', '.agent-done-agent-live']) {
      await writeFile(join(tree, name), 'summary');
      const when = new Date(Date.now() - OLD);
      await utimes(join(tree, name), when, when);
    }

    const dirs = await checkoutDirsOf([repo]);
    // Git prints the long, forward-slash form; Windows temp dirs arrive as 8.3 short names.
    expect(dirs.map(d => realpathSync.native(d))).toContain(realpathSync.native(tree));
    expect(await sweepStaleDoneSentinels(dirs, new Set(['agent-live']))).toBe(1);
    expect(await readdir(tree)).toContain('.agent-done-agent-live');
    expect(await readdir(tree)).not.toContain('.agent-done-agent-dead');
    expect((await execGit(['status', '--porcelain'], tree)).stdout).not.toContain('agent-dead');
  });
});
