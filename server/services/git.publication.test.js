import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Observe real command completion to attempt a retirement between pull and push.
const observation = vi.hoisted(() => ({ afterCommand: null }));
vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    execGit: async (...args) => {
      const result = await actual.execGit(...args);
      await observation.afterCommand?.(...args);
      return result;
    }
  };
});
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox } from '../lib/gitTestRepo.js';
import { reserveCheckoutRetirement, releaseCheckoutReservation, withCheckoutPublication } from '../lib/checkoutRetirementAdmission.js';
import {
  stageFiles, unstageFiles, commit, updateBranches, checkout, pull, syncBranch,
  mergeBranch, checkoutRemoteBranch, resetToDefaultBranch,
  createBranch, fetchOrigin, push, pushAll, updateDefaultBranch, ensureLatest, getRemoteBranches
} from './git.js';

let fixture;
let linked;
beforeEach(async () => {
  fixture = await makeGitSandbox({ origin: true, prefix: 'git-publication-' });
  linked = join(fixture.scratch, 'linked');
  await execGit(['worktree', 'add', '-b', 'feature', linked], fixture.repo);
});
afterEach(async () => {
  observation.afterCommand = null;
  await destroyGitSandbox(fixture?.scratch);
});

async function checkoutState(dir) {
  const index = (await execGit(['rev-parse', '--path-format=absolute', '--git-path', 'index'], dir)).stdout.trim();
  return {
    index: await readFile(index),
    head: (await execGit(['rev-parse', 'HEAD'], dir)).stdout,
    branch: (await execGit(['symbolic-ref', 'HEAD'], dir)).stdout,
    refs: (await execGit(['show-ref'], dir)).stdout,
    status: (await execGit(['--no-optional-locks', 'status', '--porcelain'], dir)).stdout,
    contents: await readFile(join(dir, 'initial.txt'), 'utf8')
  };
}

describe('Git service publication fencing', () => {
  it('keeps genuine non-Git prep as a no-op while refusing missing or malformed repositories', async () => {
    const plain = join(fixture.scratch, 'plain');
    await mkdir(plain);
    await expect(ensureLatest(plain)).resolves.toMatchObject({ success: true, skipped: 'not-a-repo' });
    await expect(ensureLatest(join(fixture.scratch, 'missing'))).rejects.toThrow();
    await writeFile(join(plain, '.git'), 'gitdir: missing-administration\n');
    await expect(ensureLatest(plain)).rejects.toThrow(/not a git repository|gitfile does not point to a valid repository/);
  });

  it('preserves both checkout indexes, contents and refs while a linked-checkout retirement is reserved', async () => {
    for (const dir of [fixture.repo, linked]) {
      await writeFile(join(dir, 'initial.txt'), 'staged work\n');
      await execGit(['add', 'initial.txt'], dir);
      await writeFile(join(dir, 'initial.txt'), 'unstaged work\n');
    }
    const before = await Promise.all([fixture.repo, linked].map(checkoutState));
    const cut = await reserveCheckoutRetirement(linked, 'retained-checkout');
    try {
      const writers = [
        dir => stageFiles(dir, ['initial.txt']),
        dir => unstageFiles(dir, ['initial.txt']),
        dir => commit(dir, 'must remain uncommitted'),
        updateBranches,
        dir => checkout(dir, 'main'),
        pull,
        dir => syncBranch(dir, 'main'),
        dir => mergeBranch(dir, 'main'),
        dir => checkoutRemoteBranch(dir, 'main'),
        resetToDefaultBranch,
        dir => createBranch(dir, 'must-not-exist'),
        fetchOrigin,
        push,
        pushAll,
        updateDefaultBranch,
        ensureLatest,
        dir => getRemoteBranches(dir, { force: true })
      ];
      for (const dir of [fixture.repo, linked]) {
        for (const writer of writers) {
          await expect(writer(dir)).rejects.toMatchObject({ code: 'CHECKOUT_RETIREMENT_RESERVED' });
        }
      }
      expect(await Promise.all([fixture.repo, linked].map(checkoutState))).toEqual(before);
    } finally {
      await releaseCheckoutReservation(cut);
    }
    await stageFiles(linked, ['initial.txt']);
    expect((await execGit(['show', ':initial.txt'], linked)).stdout).toBe('unstaged work\n');
  });

  it('keeps the publication across the complete pull-and-push sync operation', async () => {
    const phases = [];
    observation.afterCommand = async args => {
      if (!['pull', 'push'].includes(args[0])) return;
      phases.push(args[0]);
      await expect(reserveCheckoutRetirement(linked, 'mid-sync-cut')).rejects.toThrow('checkout-retirement-reserved');
    };
    await expect(syncBranch(fixture.repo, 'main')).resolves.toMatchObject({ success: true, pulled: true, pushed: true });
    expect(phases).toEqual(['pull', 'push']);
    const cut = await reserveCheckoutRetirement(linked, 'after-sync-cut');
    await releaseCheckoutReservation(cut);
  });

  it('supports nested service writers without releasing their enclosing repository publication', async () => {
    await withCheckoutPublication(fixture.repo, async () => {
      await writeFile(join(linked, 'initial.txt'), 'nested publication\n');
      await stageFiles(linked, ['initial.txt']);
      await commit(linked, 'nested publication');
      await expect(reserveCheckoutRetirement(linked, 'nested-cut')).rejects.toThrow('checkout-retirement-reserved');
    });
    expect((await execGit(['show', 'HEAD:initial.txt'], linked)).stdout).toBe('nested publication\n');
    const cut = await reserveCheckoutRetirement(linked, 'completed-cut');
    await releaseCheckoutReservation(cut);
  });
});
