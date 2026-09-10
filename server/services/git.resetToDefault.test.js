/**
 * Tests for the "reset to origin's default branch" escape hatch behind the
 * Apps → Git tab button.
 *
 * The whole point of the operation is that it destroys work, so the things
 * worth pinning are its guard rails: it refuses to run in a linked worktree or
 * under a live CoS agent, it reports the pre-reset sha so the destruction is
 * undoable, it never runs `git clean` (untracked files survive), and an
 * unreachable origin degrades to the cached ref instead of failing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execGitMock = vi.hoisted(() => vi.fn());
const getAgentsMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/execGit.js', () => ({
  execGit: execGitMock,
  execGitSafe: (...args) => execGitMock(...args).catch(err => ({ exitCode: 1, stdout: '', stderr: err.message }))
}));

// Only the sequencer-state probe reads the filesystem here; everything else in
// git.js reaches git through the mock above.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: existsSyncMock
}));

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgents: getAgentsMock
}));

import { resetToDefaultBranch, clearFetchCache } from './git.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

/** Args a call was made with, joined for readable matching. */
const key = (args) => args.join(' ');

/**
 * Drive execGit from a table of `'joined args' -> result`, so each test states
 * only the responses it cares about. Unlisted commands resolve empty, which is
 * what the optional probes in getDefaultBranch expect.
 */
function routeGit(table) {
  execGitMock.mockImplementation((args) => {
    const entry = table[key(args)];
    if (entry instanceof Error) return Promise.reject(entry);
    return Promise.resolve(entry ?? ok());
  });
}

const HAPPY_PATH = {
  // rev-parse prints one line per flag, so both dirs come back in one spawn.
  'rev-parse --git-dir --git-common-dir': ok('.git\n.git'),
  'fetch origin': ok(),
  'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main'),
  'rev-parse --verify refs/remotes/origin/main': ok('a'.repeat(40)),
  // Same trick for HEAD: the sha, then the branch name it is on.
  'rev-parse HEAD --abbrev-ref HEAD': ok(`${'b'.repeat(40)}\nfeature/wip`),
  'status --porcelain': ok(' M client/package-lock.json\n M server/index.js'),
  'checkout --force -B main origin/main': ok()
};

/** Every command the run issued, joined — for "did it / didn't it" assertions. */
const calledCommands = () => execGitMock.mock.calls.map(([args]) => key(args));

beforeEach(() => {
  execGitMock.mockReset();
  getAgentsMock.mockReset();
  getAgentsMock.mockResolvedValue([]);
  // Default: no rebase/cherry-pick/revert in progress.
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
  clearFetchCache();
});

describe('resetToDefaultBranch', () => {
  it('fetches, then points the default branch at origin and checks it out', async () => {
    routeGit(HAPPY_PATH);

    const result = await resetToDefaultBranch('/repo');

    expect(result.success).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.fetched).toBe(true);
    expect(calledCommands()).toEqual(
      expect.arrayContaining(['fetch origin', 'checkout --force -B main origin/main'])
    );
  });

  it('does not follow the forced checkout with a redundant reset --hard', async () => {
    // `checkout --force -B` already resets index AND working tree to the target
    // (verified against real git with staged adds, modifications and deletes),
    // so a trailing `reset --hard` re-walks every tracked file to change nothing.
    routeGit(HAPPY_PATH);

    await resetToDefaultBranch('/repo');

    expect(calledCommands().some((cmd) => cmd.startsWith('reset --hard'))).toBe(false);
  });

  it('reports the pre-reset branch, sha, and dirty-file count so the reset is undoable', async () => {
    routeGit(HAPPY_PATH);

    const result = await resetToDefaultBranch('/repo');

    expect(result.previousBranch).toBe('feature/wip');
    expect(result.previousHead).toBe('b'.repeat(40));
    expect(result.discardedFiles).toBe(2);
  });

  it('reports null, not an empty string, when a repo has no commits to name', async () => {
    // `''.split('\n')` is `['']`, and a destructuring default only fires on
    // undefined — so the empty case has to be normalized explicitly or the
    // contract (and the client's `if (result.previousHead)` hint) gets `''`.
    routeGit({ ...HAPPY_PATH, 'rev-parse HEAD --abbrev-ref HEAD': ok('') });

    const result = await resetToDefaultBranch('/repo');

    expect(result.previousHead).toBeNull();
    expect(result.previousBranch).toBeNull();
  });

  it('never runs git clean — untracked files are not recoverable from a reflog', async () => {
    routeGit(HAPPY_PATH);

    await resetToDefaultBranch('/repo');

    expect(calledCommands().some((cmd) => cmd.startsWith('clean'))).toBe(false);
  });

  it('excludes untracked files from the discarded count, since it keeps them', async () => {
    // Counting `??` entries would claim more was destroyed than was — the
    // confirm dialog promises "keeps untracked files" two rows above the number.
    routeGit({
      ...HAPPY_PATH,
      'status --porcelain': ok(' M tracked.js\nA  staged.js\n?? scratch.log\n?? build/')
    });

    const result = await resetToDefaultBranch('/repo');

    expect(result.discardedFiles).toBe(2);
  });

  it('clears a half-finished rebase, which the forced checkout leaves behind', async () => {
    // Verified against real git: `checkout --force` empties the tree and index
    // but leaves .git/rebase-merge, so the reset "succeeds" into a repo where
    // every later `git rebase` dies on "already a rebase-merge directory".
    existsSyncMock.mockImplementation((path) => String(path).endsWith('rebase-merge'));
    routeGit(HAPPY_PATH);

    const result = await resetToDefaultBranch('/repo');

    expect(result.clearedOperations).toEqual(['rebase']);
    expect(calledCommands()).toContain('rebase --quit');
    // --quit, never --abort: abort rewinds to the pre-rebase HEAD, which is the
    // state the reset is deliberately discarding.
    expect(calledCommands().some((cmd) => cmd.includes('--abort'))).toBe(false);
    // And it runs BEFORE the checkout, so the checkout lands on a normal repo.
    expect(calledCommands().indexOf('rebase --quit'))
      .toBeLessThan(calledCommands().indexOf('checkout --force -B main origin/main'));
  });

  it('leaves the sequencer alone when no operation is in progress', async () => {
    routeGit(HAPPY_PATH);

    const result = await resetToDefaultBranch('/repo');

    expect(result.clearedOperations).toEqual([]);
    expect(calledCommands().some((cmd) => cmd.includes('--quit'))).toBe(false);
  });

  it('refuses to reset a linked worktree', async () => {
    routeGit({
      ...HAPPY_PATH,
      'rev-parse --git-dir --git-common-dir': ok('/repo/.git/worktrees/agent-1\n/repo/.git')
    });

    await expect(resetToDefaultBranch('/repo/wt')).rejects.toThrow(/linked worktree/);
    // Refused before anything touched the working tree.
    expect(calledCommands().some((cmd) => cmd.startsWith('checkout'))).toBe(false);
  });

  it('refuses while a CoS agent is running in the same checkout', async () => {
    // Agents spawned without a worktree work directly in the checkout, so a
    // reset would discard edits a live run is still writing.
    routeGit(HAPPY_PATH);
    getAgentsMock.mockResolvedValue([
      { id: 'agent-live', status: 'running', metadata: { workspacePath: '/repo/' } }
    ]);

    await expect(resetToDefaultBranch('/repo')).rejects.toThrow(/agent-live/);
    expect(calledCommands().some((cmd) => cmd.startsWith('checkout'))).toBe(false);
  });

  it('ignores agents that finished, or that are running somewhere else', async () => {
    routeGit(HAPPY_PATH);
    getAgentsMock.mockResolvedValue([
      { id: 'agent-done', status: 'completed', metadata: { workspacePath: '/repo' } },
      { id: 'agent-elsewhere', status: 'running', metadata: { workspacePath: '/other-repo' } },
      { id: 'agent-worktree', status: 'running', metadata: { workspacePath: '/repo/wt' } }
    ]);

    await expect(resetToDefaultBranch('/repo')).resolves.toMatchObject({ success: true });
  });

  it('falls back to the cached ref when origin is unreachable', async () => {
    routeGit({
      ...HAPPY_PATH,
      'fetch origin': new Error('fatal: unable to access origin: Could not resolve host')
    });

    const result = await resetToDefaultBranch('/repo');

    expect(result.fetched).toBe(false);
    expect(result.success).toBe(true);
    expect(calledCommands()).toContain('checkout --force -B main origin/main');
  });

  it('refuses when the default branch cannot be determined', async () => {
    routeGit({
      'rev-parse --git-dir --git-common-dir': ok('.git\n.git'),
      'fetch origin': ok(),
      // No origin/HEAD, no local branches, and a detached HEAD leave nothing to
      // resolve — every getDefaultBranch fallback comes back empty.
      'rev-parse --abbrev-ref HEAD': ok('HEAD')
    });

    await expect(resetToDefaultBranch('/repo')).rejects.toThrow(/default branch/);
  });

  it('refuses when there is no origin ref to reset to', async () => {
    routeGit({
      ...HAPPY_PATH,
      // origin/HEAD names a branch whose remote-tracking ref is gone.
      'rev-parse --verify refs/remotes/origin/main': { stdout: '', stderr: 'fatal: Needed a single revision', exitCode: 1 },
      'branch --list': ok('* main')
    });

    await expect(resetToDefaultBranch('/repo')).rejects.toThrow(/origin\/main/);
    expect(calledCommands().some((cmd) => cmd.startsWith('checkout'))).toBe(false);
  });
});
