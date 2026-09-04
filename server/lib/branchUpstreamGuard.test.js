/**
 * Agent-branch upstream guard tests (#4172).
 *
 * Run against REAL git repositories in a temp dir, not a mocked `execGit`. The
 * entire premise of the bug is a git DEFAULT — `branch.autoSetupMerge` quietly
 * recording `merge=refs/heads/main` on a branch created from `origin/main` — and
 * a mock that returns whatever the test author believed `git config` prints
 * would assert the author's belief rather than git's behavior. The first test
 * below is the bypass probe: it reproduces the bug with the un-fixed command, so
 * the flag the fix adds is demonstrably load-bearing.
 *
 * Sandboxes come from `gitTestRepo.js` (one template per worker, then copied).
 * `VITEST_FAST=1` skips the real-git describes and keeps `isSafeBranchUpstream`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { execGit } from './execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from './gitTestRepo.js';
import {
  enforceSafeBranchUpstream,
  isSafeBranchUpstream,
  readBranchUpstream,
} from './branchUpstreamGuard.js';

let repo;
let scratch;

async function commit(subject) {
  await writeFile(join(repo, `${subject.replace(/\W+/g, '-')}.txt`), subject);
  await execGit(['add', '-A'], repo);
  await execGit(['commit', '-m', subject], repo);
}

/** The `branch.<name>.merge` a config-derived push (`HEAD:<merge>`) would target. */
const mergeRef = async (branch) => (await readBranchUpstream(repo, branch)).merge;

function useOriginSandbox() {
  beforeEach(async () => {
    ({ scratch, repo } = await makeGitSandbox({ origin: true, prefix: 'portos-branch-upstream-' }));
  });
  afterEach(async () => {
    await destroyGitSandbox(scratch);
  });
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('the bug this guard exists for (#4172)', () => {
  useOriginSandbox();

  it('git auto-tracks refs/heads/main when a worktree branch is cut from origin/main', async () => {
    // The UN-fixed command, verbatim. If this ever stops recording `main`, the
    // `--no-track` flag in worktreeManager.js has become unnecessary — and this
    // test is what says so.
    const path = join(scratch, 'wt-unfixed');
    await execGit(['worktree', 'add', '-b', 'cos/task-1/agent-1', path, 'origin/main'], repo);
    expect(await mergeRef('cos/task-1/agent-1')).toBe('refs/heads/main');
  });

  it('leaves the branch untracked with --no-track, so a push -u names its own ref', async () => {
    const path = join(scratch, 'wt-fixed');
    await execGit(['worktree', 'add', '--no-track', '-b', 'cos/task-2/agent-2', path, 'origin/main'], repo);
    expect(await mergeRef('cos/task-2/agent-2')).toBe('');
  });
});

describe('isSafeBranchUpstream', () => {
  it('treats an absent upstream as safe — that is the untracked shape push -u expects', () => {
    expect(isSafeBranchUpstream('cos/task/agent', '')).toBe(true);
  });

  it('accepts an upstream naming the branch\'s own ref, in either form', () => {
    expect(isSafeBranchUpstream('feature/x', 'refs/heads/feature/x')).toBe(true);
    expect(isSafeBranchUpstream('feature/x', 'feature/x')).toBe(true);
  });

  it('accepts a branch tracking a FORK remote, because the invariant is on the REF (#6064)', () => {
    // A fork PR's head is attached from `fork-<owner>/<branch>`, so its upstream
    // is `remote=fork-contributor, merge=refs/heads/<branch>`. Judging the
    // REMOTE instead of the ref would have this guard "repair" that away — and a
    // config-derived push would then land the contributor's commits on origin.
    expect(isSafeBranchUpstream('contributor/fix-thing', 'refs/heads/contributor/fix-thing')).toBe(true);
  });

  it('rejects the default branch — the ref a config-derived push must never resolve to', () => {
    expect(isSafeBranchUpstream('cos/task/agent', 'refs/heads/main')).toBe(false);
  });

  it('rejects any OTHER foreign ref too, not just the default branch', () => {
    // The invariant is "its own ref", not "not main": a push aimed at someone
    // else's branch is the same class of mistake, one blast radius smaller.
    expect(isSafeBranchUpstream('cos/task/agent', 'refs/heads/release')).toBe(false);
  });

  it('rejects an UNREADABLE upstream — an unanswered safety question is not a pass', () => {
    // `null` is readBranchUpstream's could-not-read sentinel. Treating it as ''
    // would wave through a branch that really does track main whenever git is
    // wedged, which is the one moment the guard most needs to hold.
    expect(isSafeBranchUpstream('cos/task/agent', null)).toBe(false);
    expect(isSafeBranchUpstream('cos/task/agent', undefined)).toBe(false);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('readBranchUpstream', () => {
  useOriginSandbox();

  it('reports both halves of a configured upstream', async () => {
    expect(await readBranchUpstream(repo, 'main')).toEqual({ remote: 'origin', merge: 'refs/heads/main' });
  });

  it('reports empty strings — not null — for an untracked branch', async () => {
    await execGit(['branch', '--no-track', 'solo', 'main'], repo);
    expect(await readBranchUpstream(repo, 'solo')).toEqual({ remote: '', merge: '' });
  });

  it('reports null — NOT empty — when the config cannot be read at all', async () => {
    // The distinction that matters: `''` means "no upstream configured", `null`
    // means "we could not find out". Collapsing them lets an unreadable repo
    // masquerade as a healthy untracked branch.
    expect(await readBranchUpstream(join(scratch, 'nope'), 'main')).toEqual({ remote: null, merge: null });
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('enforceSafeBranchUpstream', () => {
  useOriginSandbox();

  it('repairs a branch left tracking the default branch', async () => {
    const path = join(scratch, 'wt-legacy');
    // A branch in the shape every pre-fix agent worktree had.
    await execGit(['worktree', 'add', '-b', 'cos/task-3/agent-3', path, 'origin/main'], repo);
    expect(await mergeRef('cos/task-3/agent-3')).toBe('refs/heads/main');

    const result = await enforceSafeBranchUpstream(repo, 'cos/task-3/agent-3');

    expect(result).toEqual({ safe: true, repaired: true, upstream: 'refs/heads/main' });
    expect(await mergeRef('cos/task-3/agent-3')).toBe('');
  });

  it('makes the config-derived push land on the branch, not on main', async () => {
    // Acceptance criterion 2, executed rather than asserted about: run the exact
    // `git push "$(git config …remote)" "HEAD:$(git config …merge)"` shape
    // /do:pr uses, and check where the commit ended up.
    const path = join(scratch, 'wt-push');
    await execGit(['worktree', 'add', '-b', 'cos/task-4/agent-4', path, 'origin/main'], repo);
    await enforceSafeBranchUpstream(repo, 'cos/task-4/agent-4');

    await writeFile(join(path, 'agent-work.txt'), 'agent work');
    await execGit(['add', '-A'], path);
    await execGit(['commit', '-m', 'agent work'], path);
    const mainBefore = (await execGit(['rev-parse', 'origin/main'], repo)).stdout.trim();

    const { remote, merge } = await readBranchUpstream(path, 'cos/task-4/agent-4');
    // Nothing left to derive a destination from — the repaired shape forces the
    // caller onto the `push -u origin <branch>` path, which names the branch.
    expect(remote).toBe('');
    expect(merge).toBe('');
    await execGit(['push', '-u', 'origin', 'cos/task-4/agent-4'], path);

    expect((await execGit(['rev-parse', 'origin/main'], repo)).stdout.trim()).toBe(mainBefore);
    expect((await execGit(['rev-parse', 'origin/cos/task-4/agent-4'], repo)).stdout.trim())
      .toBe((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim());
  });

  it('leaves a branch tracking its own remote ref alone', async () => {
    // The review-loop shape: a worktree re-attached to a branch a previous agent
    // already pushed. `merge` names the branch itself, so a config-derived push
    // is correct and must not be disturbed.
    const path = join(scratch, 'wt-existing');
    await execGit(['worktree', 'add', '-b', 'cos/task-5/agent-5', path, 'origin/main'], repo);
    await execGit(['push', '-u', 'origin', 'cos/task-5/agent-5'], path);

    const result = await enforceSafeBranchUpstream(repo, 'cos/task-5/agent-5');

    expect(result).toEqual({ safe: true, repaired: false, upstream: 'refs/heads/cos/task-5/agent-5' });
    expect(await mergeRef('cos/task-5/agent-5')).toBe('refs/heads/cos/task-5/agent-5');
  });

  it('is a no-op on an already-untracked branch', async () => {
    await execGit(['branch', '--no-track', 'cos/task-6/agent-6', 'main'], repo);
    expect(await enforceSafeBranchUpstream(repo, 'cos/task-6/agent-6'))
      .toEqual({ safe: true, repaired: false, upstream: '' });
  });

  it('tolerates missing arguments rather than throwing', async () => {
    expect(await enforceSafeBranchUpstream(null, 'branch')).toEqual({ safe: true, repaired: false, upstream: '' });
    expect(await enforceSafeBranchUpstream(repo, '')).toEqual({ safe: true, repaired: false, upstream: '' });
  });

  it('refuses a branch whose upstream config cannot be read', async () => {
    // Fail CLOSED: nothing here verified the branch is safe, and reporting it as
    // untracked would hand an agent a branch that may still push to main.
    await expect(enforceSafeBranchUpstream(join(scratch, 'nope'), 'cos/task/agent'))
      .rejects.toThrow(/could not be read/);
  });

  it('throws when the bad upstream survives the repair', async () => {
    // git cannot unset an upstream it does not consider configured: set ONLY
    // `merge`, with no `remote`, and `--unset-upstream` fails with "no upstream
    // configured" while `branch.<name>.merge` — the value a config-derived push
    // reads — still says `main`. Exactly the state that must fail loudly.
    await execGit(['branch', '--no-track', 'cos/task-7/agent-7', 'main'], repo);
    await execGit(['config', 'branch.cos/task-7/agent-7.merge', 'refs/heads/main'], repo);

    await expect(enforceSafeBranchUpstream(repo, 'cos/task-7/agent-7')).rejects.toThrow(/refs\/heads\/main/);
  });
});
