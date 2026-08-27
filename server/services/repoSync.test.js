/**
 * Unit tests for the repo-sync deterministic core.
 *
 * The contract under test is a SAFETY contract, so the assertions are about the
 * decisions and the exact git argv, never about re-deriving the implementation:
 *
 * - planRepoSync — the pure decision table. Which shapes earn an automatic step
 *   and which are handed to the agent instead.
 * - the executor — that the argv it issues is the non-destructive form
 *   (`--ff-only`, a `<b>:<b>` refspec, a plain push with no `--force`), and that
 *   a stash drop re-verifies the sha it resolved during the scan.
 * - classifyStash — a stash is "superseded" only when it is provably a no-op.
 * - shouldDispatchVerifier — when an agent is spawned at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execGitMock = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
vi.mock('../lib/execGit.js', () => ({ execGit: (...args) => execGitMock(...args) }));

const gitMocks = {
  // execGitSafe is git.js's own catch-into-a-failed-result wrapper; the suite
  // routes it at the same mock so argv assertions see every call.
  execGitSafe: vi.fn((...args) => execGitMock(...args)),
  fetchOrigin: vi.fn(async () => undefined),
  findActiveAgentInWorkspace: vi.fn(async () => null),
  getBranch: vi.fn(async () => 'main'),
  getBranches: vi.fn(async () => []),
  getDefaultBranch: vi.fn(async () => 'main'),
  getStatusPorcelain: vi.fn(async () => ''),
  isBranchMergedInto: vi.fn(async () => false),
  isRepo: vi.fn(async () => true)
};
vi.mock('./git.js', () => gitMocks);
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({ hasOrigin: true, host: 'github.com' }))
}));
const reconcileMock = vi.fn(async () => ({ defaultBranch: 'main', cleaned: [], inFlight: [], wip: [], skipped: [], orphanRemotes: { reaped: [], reported: [] } }));
vi.mock('./branchReconcile.js', () => ({ reconcile: (...args) => reconcileMock(...args) }));

const {
  ESCALATION_KINDS,
  MAX_STASH_PATHS_FOR_AUTO_CLASSIFY,
  classifyStash,
  describeStep,
  formatRepoSyncReport,
  parseStashList,
  planRepoSync,
  resolveSyncTargets,
  shouldDispatchVerifier,
  dirtyTrackedPaths,
  stashIndex,
  summarizeSync,
  syncRepo
} = await import('./repoSync.js');

/** A snapshot in the fully-synced end state; each test perturbs one thing. */
const cleanState = (over = {}) => ({
  repoPath: '/tmp/example-repo',
  isRepo: true,
  hasOrigin: true,
  fetchError: null,
  defaultBranch: 'main',
  remoteDefault: 'origin/main',
  currentBranch: 'main',
  operationInProgress: null,
  readFailures: [],
  remotes: ['origin'],
  dirtyTracked: [],
  branches: [{ name: 'main', current: true, tracking: 'origin/main', ahead: 0, behind: 0, isDefault: true, merged: false, worktree: false }],
  defaultDivergence: { ahead: 0, behind: 0 },
  stashes: [],
  activeAgentId: null,
  currentBranchMerged: false,
  ...over
});

const branch = (name, over = {}) => ({
  name, current: false, tracking: `origin/${name}`, ahead: 0, behind: 0, isDefault: false, merged: false, worktree: false, ...over
});
// A branch that was never pushed: git reports ahead:0 for it (the count comes
// from %(upstream:track), which is empty), so the snapshot measures it against
// the default branch and stores the result as localAhead.
const localBranch = (name, localAhead) => branch(name, { tracking: null, ahead: 0, localAhead });

const kinds = (escalations) => escalations.map((e) => e.kind);
const stepKinds = (steps) => steps.map((s) => s.kind);

beforeEach(() => {
  vi.clearAllMocks();
  execGitMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  reconcileMock.mockResolvedValue({ defaultBranch: 'main', cleaned: [], inFlight: [], wip: [], skipped: [], orphanRemotes: { reaped: [], reported: [] } });
});

describe('dirtyTrackedPaths', () => {
  it('keeps tracked changes and drops untracked ones', () => {
    expect(dirtyTrackedPaths(' M server/index.js\n?? scratch.txt\nA  new.js\n'))
      .toEqual(['server/index.js', 'new.js']);
  });

  it('reports the post-rename name, not both halves as one path', () => {
    expect(dirtyTrackedPaths('R  server/old.js -> server/new.js\n')).toEqual(['server/new.js']);
  });

  it('is empty for a clean tree', () => {
    expect(dirtyTrackedPaths('')).toEqual([]);
  });
});

describe('parseStashList', () => {
  it('parses ref, sha, parent count and message', () => {
    const parsed = parseStashList('stash@{0}\x1fabc123\x1fp1 p2\x1fWIP on main: 1234 subject\nstash@{1}\x1fdef456\x1fp1 p2 p3\x1fOn feature: notes');
    expect(parsed).toEqual([
      { ref: 'stash@{0}', sha: 'abc123', parentCount: 2, message: 'WIP on main: 1234 subject' },
      // Three parents ⇒ taken with `-u`, so it also carries untracked files.
      { ref: 'stash@{1}', sha: 'def456', parentCount: 3, message: 'On feature: notes' }
    ]);
  });

  it('drops malformed lines rather than yielding a half-parsed entry', () => {
    expect(parseStashList('garbage\n\nstash@{0}\x1fabc\x1fp1 p2\x1fmsg')).toHaveLength(1);
  });

  it('keeps a message containing the separator intact', () => {
    const [entry] = parseStashList('stash@{0}\x1fabc\x1fp1 p2\x1fa\x1fb');
    expect(entry.message).toBe('a\x1fb');
  });
});

describe('stashIndex', () => {
  it('reads the numeric index and rejects anything else', () => {
    expect(stashIndex('stash@{3}')).toBe(3);
    expect(stashIndex('refs/stash')).toBe(-1);
    expect(stashIndex(undefined)).toBe(-1);
  });
});

describe('planRepoSync — refuses to act on an unsettled repo', () => {
  it('plans nothing at all while a rebase is in progress', () => {
    const { steps, escalations } = planRepoSync(cleanState({
      operationInProgress: 'rebase',
      currentBranch: 'feature/x',
      dirtyTracked: ['a.js'],
      defaultDivergence: { ahead: 0, behind: 4 }
    }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.OPERATION_IN_PROGRESS]);
    expect(escalations[0].detail).toContain('rebase');
  });

  it('reports a failed fetch without blocking the rest of the plan', () => {
    const { escalations } = planRepoSync(cleanState({ fetchError: 'could not read from remote' }));
    expect(kinds(escalations)).toContain(ESCALATION_KINDS.SCAN_FAILED);
  });

  it('refuses to mutate a repository with no origin remote', () => {
    const { steps, escalations } = planRepoSync(cleanState({ hasOrigin: false, remoteDefault: null }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.SCAN_FAILED]);
    expect(escalations[0].detail).toContain('no origin remote');
  });

  it('plans nothing when a snapshot read failed', () => {
    // An unreadable status/branch/stash read defaults to the value that LOOKS
    // safe (clean tree, no branches, no stashes) — exactly the values that unlock
    // mutations. The gate refuses until the snapshot is whole.
    const { steps, escalations } = planRepoSync(cleanState({
      readFailures: ['working-tree status: git died'],
      branches: [branch('feature/x', { ahead: 2 })],
      defaultDivergence: { ahead: 0, behind: 3 }
    }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.SCAN_FAILED]);
  });

  it('plans no remote-dependent action when the fetch failed', () => {
    // Every remote-derived number is stale without a successful fetch, so a push
    // or fast-forward would act on a guess.
    const { steps, escalations } = planRepoSync(cleanState({
      fetchError: 'could not read from remote',
      branches: [branch('feature/x', { ahead: 2 })],
      defaultDivergence: { ahead: 0, behind: 3 }
    }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.SCAN_FAILED]);
  });

  it('does nothing to a repo that is already in the target state', () => {
    const { steps, escalations } = planRepoSync(cleanState());
    expect(steps).toEqual([]);
    expect(escalations).toEqual([]);
  });
});

describe('planRepoSync — publishing local commits', () => {
  it('pushes a branch that is strictly ahead of its upstream', () => {
    const { steps } = planRepoSync(cleanState({ branches: [branch('feature/x', { ahead: 2 })] }));
    expect(steps).toEqual([{ kind: 'push', branch: 'feature/x', ahead: 2, remote: 'origin', remoteRef: 'feature/x' }]);
  });

  it('does not push a branch checked out in another worktree', () => {
    const { steps, escalations } = planRepoSync(cleanState({
      branches: [branch('feature/x', { ahead: 2, worktree: true })]
    }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.IN_FLIGHT_BRANCH]);
    expect(escalations[0].detail).toContain('another worktree');
  });

  it('never pushes a branch that has diverged — it escalates instead', () => {
    const { steps, escalations } = planRepoSync(cleanState({ branches: [branch('feature/x', { ahead: 2, behind: 3 })] }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.DIVERGED_BRANCH]);
  });

  it('escalates local commits on a branch with no upstream', () => {
    // Keyed on localAhead, NOT ahead: git reports ahead:0 for every branch
    // without an upstream, so an `ahead`-keyed check could never fire for
    // exactly the never-pushed branches this escalation exists to catch.
    const { steps, escalations } = planRepoSync(cleanState({ branches: [localBranch('feature/x', 4)] }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.UNPUSHED_BRANCH]);
    expect(escalations[0].detail).toContain('4 commit(s) not on main');
  });

  it('ignores an upstream-less branch carrying no commits of its own', () => {
    const { steps, escalations } = planRepoSync(cleanState({ branches: [localBranch('scratch', 0)] }));
    expect(steps).toEqual([]);
    expect(escalations).toEqual([]);
  });

  it('pushes to the branch\'s CONFIGURED upstream, not origin/<local name>', () => {
    // A branch tracking a differently-named ref (or another remote) has its ahead
    // count measured against THAT upstream — pushing to origin/<local name>
    // publishes somewhere nobody watches and leaves the real upstream behind.
    const { steps } = planRepoSync(cleanState({
      remotes: ['origin', 'upstream'],
      branches: [branch('feature/x', { tracking: 'upstream/renamed-x', ahead: 1 })]
    }));
    expect(steps).toEqual([{ kind: 'push', branch: 'feature/x', ahead: 1, remote: 'upstream', remoteRef: 'renamed-x' }]);
  });

  it('refuses to guess when the upstream names a remote this repo does not have', () => {
    const { steps, escalations } = planRepoSync(cleanState({
      remotes: ['origin'],
      branches: [branch('feature/x', { tracking: 'gone/feature/x', ahead: 1 })]
    }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.UNPUSHED_BRANCH]);
  });

  it('honours syncPush: false', () => {
    const { steps } = planRepoSync(cleanState({ branches: [branch('feature/x', { ahead: 2 })] }), { syncPush: false });
    expect(steps).toEqual([]);
  });
});

describe('planRepoSync — the default branch', () => {
  it('fast-forwards a default branch that is only behind', () => {
    const { steps } = planRepoSync(cleanState({ defaultDivergence: { ahead: 0, behind: 5 } }));
    expect(steps).toEqual([{ kind: 'ff-default', branch: 'main', behind: 5, checkedOut: true }]);
  });

  it('marks the fast-forward as not-checked-out when the checkout is elsewhere and stays', () => {
    const { steps } = planRepoSync(cleanState({
      currentBranch: 'feature/x',
      currentBranchMerged: false,
      branches: [branch('feature/x', { current: true, ahead: 0 })],
      defaultDivergence: { ahead: 0, behind: 1 }
    }));
    expect(steps).toContainEqual({ kind: 'ff-default', branch: 'main', behind: 1, checkedOut: false });
  });

  it('never resolves a diverged default branch automatically', () => {
    const { steps, escalations } = planRepoSync(cleanState({ defaultDivergence: { ahead: 2, behind: 3 } }));
    expect(stepKinds(steps)).not.toContain('ff-default');
    expect(kinds(escalations)).toContain(ESCALATION_KINDS.DIVERGED_DEFAULT);
  });

  it('refuses to fast-forward the checked-out default branch over a dirty tree', () => {
    const { steps, escalations } = planRepoSync(cleanState({
      dirtyTracked: ['a.js'],
      defaultDivergence: { ahead: 0, behind: 2 }
    }));
    expect(stepKinds(steps)).not.toContain('ff-default');
    // Reported ONCE. A second escalation for the same dirty tree would inflate
    // the count that drives both the dispatch reason and the "N items left for
    // you" line the coordinator prompt shows.
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.UNCOMMITTED_CHANGES]);
  });

  it('honours syncPull: false', () => {
    const { steps } = planRepoSync(cleanState({ defaultDivergence: { ahead: 0, behind: 5 } }), { syncPull: false });
    expect(steps).toEqual([]);
  });
});

describe('planRepoSync — returning to the default branch', () => {
  const offDefault = (over = {}) => cleanState({
    currentBranch: 'feature/x',
    branches: [branch('feature/x', { current: true })],
    ...over
  });

  it('switches back when the branch is clean and already merged', () => {
    const { steps, escalations } = planRepoSync(offDefault({ currentBranchMerged: true }));
    expect(steps).toEqual([{ kind: 'switch-default', from: 'feature/x', to: 'main' }]);
    expect(escalations).toEqual([]);
  });

  it('will not switch away from uncommitted work', () => {
    const { steps, escalations } = planRepoSync(offDefault({ currentBranchMerged: true, dirtyTracked: ['a.js'] }));
    expect(stepKinds(steps)).not.toContain('switch-default');
    expect(kinds(escalations)).toContain(ESCALATION_KINDS.OFF_DEFAULT_BRANCH);
  });

  it('will not touch a checkout an agent is running in — at all', () => {
    // Not merely "won't switch": pushing its branch, fast-forwarding under it, or
    // dropping its stashes all race live work just as badly.
    const { steps, escalations } = planRepoSync(offDefault({
      currentBranchMerged: true,
      activeAgentId: 'agent-7',
      branches: [branch('feature/x', { current: true, ahead: 3 })],
      defaultDivergence: { ahead: 0, behind: 2 },
      stashes: [{ ref: 'stash@{0}', sha: 's0', message: 'wip', superseded: true, reason: 'identical' }]
    }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.AGENT_AT_WORK]);
    expect(escalations[0].detail).toContain('agent-7');
  });

  it('will not switch off a branch whose work has not landed', () => {
    const { steps, escalations } = planRepoSync(offDefault({ currentBranchMerged: false }));
    expect(stepKinds(steps)).not.toContain('switch-default');
    expect(escalations.find((e) => e.kind === ESCALATION_KINDS.OFF_DEFAULT_BRANCH).detail).toContain('not in main yet');
  });

  it('honours switchDefault: false', () => {
    const { steps } = planRepoSync(offDefault({ currentBranchMerged: true }), { switchDefault: false });
    expect(steps).toEqual([]);
  });

  it('escalates a detached HEAD instead of switching', () => {
    const { steps, escalations } = planRepoSync(cleanState({ currentBranch: null }));
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.DETACHED_HEAD]);
  });
});

describe('planRepoSync — stashes', () => {
  const stash = (index, superseded) => ({
    ref: `stash@{${index}}`, sha: `sha${index}`, message: `entry ${index}`, superseded, reason: superseded ? 'identical' : 'differs', paths: 1
  });

  it('drops only the provably-redundant entries, highest index first', () => {
    const { steps, escalations } = planRepoSync(cleanState({
      stashes: [stash(0, true), stash(1, false), stash(2, true)]
    }));
    // Descending order matters: `git stash drop` renumbers everything below the
    // entry it removes, so a low-index drop invalidates the refs queued after it.
    expect(steps.map((s) => s.ref)).toEqual(['stash@{2}', 'stash@{0}']);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.STASH_ENTRIES]);
    // The refs have to reach the agent — a bare count would not tell it WHICH.
    expect(escalations[0].detail).toContain('stash@{1} "entry 1" (differs)');
    expect(escalations[0].detail).not.toContain('stash@{0}');
  });

  it('reports but never drops when dropStashes is off', () => {
    const { steps, escalations } = planRepoSync(cleanState({ stashes: [stash(0, true), stash(1, false)] }), { dropStashes: false });
    expect(steps).toEqual([]);
    expect(kinds(escalations)).toEqual([ESCALATION_KINDS.STASH_ENTRIES]);
  });

  it('leaves no escalation when every entry was redundant', () => {
    const { escalations } = planRepoSync(cleanState({ stashes: [stash(0, true)] }));
    expect(escalations).toEqual([]);
  });
});

describe('classifyStash', () => {
  /** Route each git call by its subcommand + args so order doesn't matter. */
  const scriptGit = (handlers) => {
    execGitMock.mockImplementation(async (args) => {
      for (const [match, result] of handlers) {
        if (args.join(' ').includes(match)) return { stdout: '', stderr: '', exitCode: 0, ...result };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  };

  it('treats a stash that records no change as redundant', async () => {
    scriptGit([['diff --name-only', { stdout: '' }]]);
    const verdict = await classifyStash('/repo', 'sha1', 'origin/main');
    expect(verdict).toEqual({ superseded: true, reason: 'empty stash (no changes recorded)' });
  });

  it('is redundant when every touched path is identical on the target', async () => {
    scriptGit([
      ['diff --name-only', { stdout: 'a.js\nb.js\n' }],
      ['diff --quiet', { exitCode: 0 }]
    ]);
    const verdict = await classifyStash('/repo', 'sha1', 'origin/main');
    expect(verdict.superseded).toBe(true);
    expect(verdict.reason).toContain('all 2 path(s)');
    // The comparison must be scoped to the stash's own paths — an unscoped diff
    // would compare the whole worktree and never come back clean.
    const diffCall = execGitMock.mock.calls.map(([args]) => args).find((args) => args[0] === 'diff' && args.includes('--quiet'));
    expect(diffCall).toEqual(['diff', '--quiet', 'sha1', 'origin/main', '--', 'a.js', 'b.js']);
  });

  it('is NOT redundant when the target differs', async () => {
    scriptGit([
      ['diff --name-only', { stdout: 'a.js\n' }],
      ['diff --quiet', { exitCode: 1 }]
    ]);
    expect((await classifyStash('/repo', 'sha1', 'origin/main')).superseded).toBe(false);
  });

  it('includes the untracked snapshot from the third parent in the comparison', async () => {
    scriptGit([
      ['diff --name-only', { stdout: 'a.js\n' }],
      ['ls-tree', { stdout: 'scratch/new.txt\n' }],
      ['diff --quiet', { exitCode: 0 }]
    ]);
    await classifyStash('/repo', 'sha1', 'origin/main', 3);
    const quiet = execGitMock.mock.calls.map(([args]) => args).filter((args) => args[0] === 'diff' && args.includes('--quiet'));
    // The untracked path lives ONLY in the stash's third parent. Comparing it
    // against the stash COMMIT would find it missing on both sides and call the
    // stash redundant — dropping the untracked work outright.
    const untrackedProbe = quiet.find((args) => args.includes('scratch/new.txt'));
    expect(untrackedProbe).toEqual(['diff', '--quiet', 'sha1^3', 'origin/main', '--', 'scratch/new.txt']);
    const trackedProbe = quiet.find((args) => args.includes('a.js'));
    expect(trackedProbe).toEqual(['diff', '--quiet', 'sha1', 'origin/main', '--', 'a.js']);
  });

  it('keeps a stash whose untracked content is NOT on the target', async () => {
    scriptGit([
      ['diff --name-only', { stdout: '' }],
      ['ls-tree', { stdout: 'scratch/new.txt\n' }],
      ['diff --quiet', { exitCode: 1 }]
    ]);
    const verdict = await classifyStash('/repo', 'sha1', 'origin/main', 3);
    expect(verdict.superseded).toBe(false);
    expect(verdict.reason).toContain('untracked content differs');
  });

  it('keeps a stash whose path list could not be read', async () => {
    // An unreadable path list used to collapse to "no paths", which reads as an
    // empty stash — and an empty stash is dropped.
    scriptGit([['diff --name-only', { exitCode: 128 }]]);
    const verdict = await classifyStash('/repo', 'sha1', 'origin/main');
    expect(verdict.superseded).toBe(false);
    expect(verdict.reason).toContain('could not read');
  });

  it('keeps a -u stash whose third-parent read failed', async () => {
    scriptGit([['diff --name-only', { stdout: 'a.js\n' }], ['ls-tree', { exitCode: 128 }]]);
    const verdict = await classifyStash('/repo', 'sha1', 'origin/main', 3);
    expect(verdict.superseded).toBe(false);
    expect(verdict.reason).toContain('could not read');
  });

  it('skips the third-parent read for a stash that has no untracked half', async () => {
    // Every stash NOT taken with `-u` has two parents, so `<sha>^3` cannot
    // resolve — spawning it is a guaranteed failure per ordinary stash.
    scriptGit([['diff --name-only', { stdout: 'a.js\n' }], ['diff --quiet', { exitCode: 0 }]]);
    const verdict = await classifyStash('/repo', 'sha1', 'origin/main', 2);
    expect(verdict.superseded).toBe(true);
    expect(execGitMock.mock.calls.some(([args]) => args[0] === 'ls-tree')).toBe(false);
  });

  it('refuses to auto-classify a stash too large to compare in one spawn', async () => {
    const many = Array.from({ length: MAX_STASH_PATHS_FOR_AUTO_CLASSIFY + 1 }, (_, i) => `f${i}.js`).join('\n');
    scriptGit([['diff --name-only', { stdout: many }]]);
    const verdict = await classifyStash('/repo', 'sha1', 'origin/main');
    expect(verdict.superseded).toBe(false);
    expect(verdict.reason).toContain('too large');
    expect(execGitMock.mock.calls.some(([args]) => args.includes('--quiet'))).toBe(false);
  });

  it('fails closed when git errors out', async () => {
    scriptGit([['diff --name-only', { stdout: 'a.js\n' }], ['diff --quiet', { exitCode: 129 }]]);
    expect((await classifyStash('/repo', 'sha1', 'origin/main')).superseded).toBe(false);
  });
});

describe('syncRepo — the argv it issues is the non-destructive form', () => {
  /**
   * Drive syncRepo through a scripted snapshot by stubbing the reads
   * collectRepoState makes, then assert the WRITE commands.
   */
  const arrange = ({ porcelain = '', branches = [], stashList = '', current = 'main', divergence = '0\t0' } = {}) => {
    gitMocks.getBranches.mockResolvedValue(branches);
    gitMocks.getStatusPorcelain.mockResolvedValue(porcelain);
    gitMocks.getBranch.mockResolvedValue(current);
    execGitMock.mockImplementation(async (args) => {
      const line = args.join(' ');
      if (line.startsWith('rev-parse --git-dir')) return { stdout: '.git', stderr: '', exitCode: 0 };
      if (line === 'remote') return { stdout: 'origin\n', stderr: '', exitCode: 0 };
      if (line.startsWith('rev-list')) return { stdout: divergence, stderr: '', exitCode: 0 };
      if (line.startsWith('stash list')) return { stdout: stashList, stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  };
  // Only the MUTATING commands — the scan's `stash list` is a read, and the
  // pruning fetch goes through git.js's `fetchOrigin`, not execGit. A refspec
  // fetch (`main:main`) IS a write: it moves a local branch ref.
  const writeCalls = () => execGitMock.mock.calls
    .map(([args]) => args)
    .filter((args) => ['push', 'checkout', 'merge'].includes(args[0])
      || (args[0] === 'stash' && args[1] === 'drop')
      || (args[0] === 'fetch' && args.some((a) => a.includes(':'))));

  it('pushes without --force and fast-forwards with --ff-only', async () => {
    // behind lands on the BRANCH entry: the snapshot reads the default branch's
    // divergence from what `getBranches` already parsed, and only falls back to a
    // `rev-list` spawn when the default branch tracks something else (exercised by
    // the next test, where `main` is absent from the branch list).
    arrange({ branches: [{ name: 'main', current: true, tracking: 'origin/main', ahead: 0, behind: 3, isDefault: true, merged: false }] });
    const result = await syncRepo({ repoPath: process.cwd(), name: 'Example' });
    expect(writeCalls()).toEqual([['merge', '--ff-only', 'origin/main']]);
    expect(result.performed).toEqual(['fast-forwarded main (3 behind origin)']);
    expect(execGitMock.mock.calls.some(([args]) => args.includes('--force') || args.includes('-f'))).toBe(false);
  });

  it('updates a non-checked-out default branch with a refspec fetch git itself refuses to non-FF', async () => {
    gitMocks.isBranchMergedInto.mockResolvedValue(false);
    arrange({
      current: 'feature/x',
      branches: [{ name: 'feature/x', current: true, tracking: 'origin/feature/x', ahead: 0, behind: 0, isDefault: false, merged: false }],
      divergence: '2\t0'
    });
    await syncRepo({ repoPath: process.cwd(), name: 'Example' });
    expect(writeCalls()).toEqual([['fetch', 'origin', 'main:main']]);
  });

  it('does not merge the default branch INTO a feature branch when the switch back fails', async () => {
    // The plan queues switch-default then ff-default and predicts the checkout
    // will be on main by then. If the checkout is refused, a `merge --ff-only
    // origin/main` issued anyway would land main's commits ON the feature
    // branch — a real change to the wrong branch. The executor re-reads HEAD.
    gitMocks.isBranchMergedInto.mockResolvedValue(true);
    arrange({
      current: 'feature/x',
      divergence: '2\t0',
      branches: [{ name: 'feature/x', current: true, tracking: 'origin/feature/x', ahead: 0, behind: 0, isDefault: false, merged: false }]
    });
    const base = execGitMock.getMockImplementation();
    // The checkout is refused (an untracked file would be overwritten), so HEAD
    // never moves off the feature branch.
    execGitMock.mockImplementation(async (args) => {
      if (args[0] === 'checkout') return { stdout: '', stderr: 'error: Your local changes would be overwritten', exitCode: 1 };
      return base(args);
    });

    const result = await syncRepo({ repoPath: process.cwd(), name: 'Example' });
    expect(writeCalls()).toEqual([['checkout', 'main'], ['fetch', 'origin', 'main:main']]);
    expect(execGitMock.mock.calls.some(([args]) => args[0] === 'merge')).toBe(false);
    expect(result.escalations.map((e) => e.kind)).toContain(ESCALATION_KINDS.ACTION_FAILED);
    expect(result.performed).toContain('fast-forwarded main (2 behind origin)');
  });

  it('records a failed step as an action-failed escalation instead of throwing', async () => {
    arrange({ branches: [{ name: 'feature/x', current: false, tracking: 'origin/feature/x', ahead: 1, behind: 0, isDefault: false, merged: false }] });
    const base = execGitMock.getMockImplementation();
    execGitMock.mockImplementation(async (args) => {
      if (args[0] === 'push') return { stdout: '', stderr: '! [rejected] feature/x -> feature/x (fetch first)', exitCode: 1 };
      return base(args);
    });
    const result = await syncRepo({ repoPath: process.cwd(), name: 'Example' });
    expect(result.performed).toEqual([]);
    expect(result.escalations.map((e) => e.kind)).toEqual([ESCALATION_KINDS.ACTION_FAILED]);
    expect(result.escalations[0].detail).toContain('rejected');
    // Pushed to the resolved upstream, as an explicit <local>:<remote-ref> refspec.
    const pushCall = execGitMock.mock.calls.map(([a]) => a).find((a) => a[0] === 'push');
    expect(pushCall).toEqual(['push', 'origin', 'feature/x:feature/x']);
  });

  it('re-verifies a stash sha before dropping it and skips a shifted ref', async () => {
    arrange({ stashList: 'stash@{0}\x1fSTASH_SHA\x1fp1 p2\x1fWIP' });
    const base = execGitMock.getMockImplementation();
    execGitMock.mockImplementation(async (args) => {
      const line = args.join(' ');
      // Prove the stash redundant during the scan…
      if (line.startsWith('diff --name-only')) return { stdout: 'a.js\n', stderr: '', exitCode: 0 };
      if (line.startsWith('ls-tree')) return { stdout: '', stderr: '', exitCode: 128 };
      if (line.startsWith('diff --quiet')) return { stdout: '', stderr: '', exitCode: 0 };
      // …then have the ref resolve to something else at drop time.
      if (line === 'rev-parse stash@{0}') return { stdout: 'OTHER_SHA', stderr: '', exitCode: 0 };
      return base(args);
    });
    const result = await syncRepo({ repoPath: process.cwd(), name: 'Example' });
    expect(execGitMock.mock.calls.some(([args]) => args[0] === 'stash' && args[1] === 'drop')).toBe(false);
    expect(result.escalations[0].detail).toContain('no longer points at');
  });

  it('carries branchReconcile cleanup and in-flight branches through', async () => {
    arrange();
    reconcileMock.mockResolvedValue({
      defaultBranch: 'main',
      cleaned: ['feature/done'],
      inFlight: [{ branch: 'feature/wip', state: 'NEEDS_PR' }],
      wip: [],
      skipped: [],
      orphanRemotes: { reaped: ['feature/gone'], reported: [{ branch: 'feature/orphan' }] }
    });
    const result = await syncRepo({ repoPath: process.cwd(), name: 'Example' });
    expect(result.performed).toContain('deleted merged branch/worktree feature/done');
    expect(result.performed).toContain('deleted merged orphan remote branch origin/feature/gone');
    expect(result.escalations.map((e) => e.kind)).toEqual([ESCALATION_KINDS.IN_FLIGHT_BRANCH, ESCALATION_KINDS.ORPHAN_REMOTE]);
  });

  it('only reaps remote branches when reapRemotes is explicitly on', async () => {
    arrange();
    await syncRepo({ repoPath: process.cwd(), name: 'Example' });
    expect(reconcileMock.mock.calls[0][1].reapRemotes).toBe(false);
    reconcileMock.mockClear();
    await syncRepo({ repoPath: process.cwd(), name: 'Example', actions: { reapRemotes: true } });
    expect(reconcileMock.mock.calls[0][1].reapRemotes).toBe(true);
  });

  it('skips branch cleanup entirely when cleanupMerged is off', async () => {
    arrange();
    await syncRepo({ repoPath: process.cwd(), name: 'Example', actions: { cleanupMerged: false } });
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('reports a missing repo path rather than running git in the wrong directory', async () => {
    const result = await syncRepo({ repoPath: '/nope/does/not/exist', name: 'Ghost' });
    expect(result.missing).toBe(true);
    expect(result.escalations[0].kind).toBe(ESCALATION_KINDS.SCAN_FAILED);
    expect(execGitMock).not.toHaveBeenCalled();
  });

  it('skips a directory that is not a git repository', async () => {
    gitMocks.isRepo.mockResolvedValueOnce(false);
    const result = await syncRepo({ repoPath: process.cwd(), name: 'Not a repo' });
    expect(result.notARepo).toBe(true);
    expect(result.escalations[0].kind).toBe(ESCALATION_KINDS.SCAN_FAILED);
  });
});

describe('describeStep', () => {
  it('names each step in the terms the report uses', () => {
    expect(describeStep({ kind: 'push', branch: 'feature/x', ahead: 2 })).toContain('pushed feature/x');
    expect(describeStep({ kind: 'switch-default', from: 'feature/x', to: 'main' })).toContain('feature/x to main');
    expect(describeStep({ kind: 'drop-stash', ref: 'stash@{0}', reason: 'identical' })).toContain('stash@{0}');
  });
});

describe('summarizeSync / shouldDispatchVerifier', () => {
  const results = (over = []) => over;

  it('counts repos, actions and escalations', () => {
    const summary = summarizeSync(results([
      { performed: ['a', 'b'], escalations: [] },
      { performed: [], escalations: [{ kind: 'x' }] },
      { performed: [], escalations: [] }
    ]));
    expect(summary).toMatchObject({ repos: 3, mutated: 1, actionCount: 2, escalated: 1, escalationCount: 1 });
  });

  it('always dispatches when something needs judgment, whatever the mode', () => {
    const summary = summarizeSync([{ performed: [], escalations: [{ kind: 'x' }] }]);
    for (const mode of ['always', 'when-changed', 'never']) {
      expect(shouldDispatchVerifier(summary, mode).dispatch).toBe(true);
    }
  });

  it('does not spawn an agent for a sweep that changed nothing', () => {
    const summary = summarizeSync([{ performed: [], escalations: [] }]);
    expect(shouldDispatchVerifier(summary, 'when-changed').dispatch).toBe(false);
    expect(shouldDispatchVerifier(summary, 'never').dispatch).toBe(false);
    expect(shouldDispatchVerifier(summary, 'always').dispatch).toBe(true);
  });

  it('verifies a run that mutated something under the default mode', () => {
    const summary = summarizeSync([{ performed: ['pushed x'], escalations: [] }]);
    expect(shouldDispatchVerifier(summary).dispatch).toBe(true);
    expect(shouldDispatchVerifier(summary, 'never').dispatch).toBe(false);
  });

  it('falls back to the default mode for an unrecognized value', () => {
    const summary = summarizeSync([{ performed: ['pushed x'], escalations: [] }]);
    expect(shouldDispatchVerifier(summary, 'whenever-i-feel-like-it').dispatch).toBe(true);
  });
});

describe('formatRepoSyncReport', () => {
  it('names every repo, what was applied and what was left', () => {
    const report = formatRepoSyncReport([
      { name: 'App One', appId: 'app-1', repoPath: '/repos/one', currentBranch: 'main', defaultBranch: 'main', performed: ['pushed feature/x (2 commit(s)) to origin'], escalations: [] },
      { name: 'App Two', appId: 'app-2', repoPath: '/repos/two', currentBranch: 'feature/y', defaultBranch: 'main', performed: [], escalations: [{ kind: ESCALATION_KINDS.UNCOMMITTED_CHANGES, detail: '3 uncommitted change(s)' }] }
    ], { verifyReason: '1 unresolved item(s)' });

    expect(report).toContain('Swept 2 repo(s): 1 action(s) applied, 1 item(s) left for you.');
    expect(report).toContain('Dispatched because: 1 unresolved item(s).');
    expect(report).toContain('### App One (app-1)');
    expect(report).toContain('pushed feature/x (2 commit(s)) to origin');
    expect(report).toContain('`uncommitted-changes` — 3 uncommitted change(s)');
    expect(report).toContain('Applied automatically: nothing (already in sync)');
  });

  it('calls out a repo whose path is gone', () => {
    const report = formatRepoSyncReport([{ name: 'Ghost', repoPath: '/gone', missing: true, performed: [], escalations: [] }]);
    expect(report).toContain('**Repo path does not exist.**');
  });
});

describe('resolveSyncTargets', () => {
  it('includes every managed app that has a repo path', () => {
    const targets = resolveSyncTargets([
      { id: 'a', name: 'App A', repoPath: '/repos/a' },
      { id: 'b', name: 'App B', repoPath: '/repos/b' }
    ]);
    expect(targets.map((t) => t.appId)).toEqual(['a', 'b']);
  });

  it('is opt-OUT: only an explicit skipRepoSync excludes an app', () => {
    const targets = resolveSyncTargets([
      { id: 'a', name: 'App A', repoPath: '/repos/a', taskTypeOverrides: { 'repo-sync': { taskMetadata: { skipRepoSync: true } } } },
      { id: 'b', name: 'App B', repoPath: '/repos/b', taskTypeOverrides: { 'other-task': { enabled: true } } },
      { id: 'c', name: 'App C', repoPath: '/repos/c', taskTypeOverrides: {} }
    ]);
    expect(targets.map((t) => t.appId)).toEqual(['b', 'c']);
  });

  it('does not read the seeded per-app enabled flag as an opt-out', () => {
    // createApp seeds `{ enabled: false }` for EVERY task type, so honouring it
    // here would make the install-wide sweep visit nothing on a fresh install.
    const targets = resolveSyncTargets([
      { id: 'a', name: 'App A', repoPath: '/repos/a', taskTypeOverrides: { 'repo-sync': { enabled: false } } }
    ]);
    expect(targets.map((t) => t.appId)).toEqual(['a']);
  });

  it('skips apps with no repo and dedupes two apps sharing one checkout', () => {
    const targets = resolveSyncTargets([
      { id: 'a', name: 'App A', repoPath: '/repos/a' },
      { id: 'b', name: 'App B' },
      { id: 'c', name: 'App C', repoPath: '/repos/a/' }
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0].appId).toBe('a');
  });

  it('layers a sanitized per-app override over the schedule-level toggles', () => {
    const [target] = resolveSyncTargets(
      [{ id: 'a', name: 'App A', repoPath: '/repos/a', taskTypeOverrides: { 'repo-sync': { taskMetadata: { dropStashes: false, notAnAllowedKey: true } } } }],
      { syncPush: true, dropStashes: true }
    );
    expect(target.actions.syncPush).toBe(true);
    expect(target.actions.dropStashes).toBe(false);
    // The override is read off the RAW app record, so it must go through the
    // same allowlist a scheduled dispatch uses.
    expect(target.actions.notAnAllowedKey).toBeUndefined();
  });

  it('strips agent options the task type manages internally', () => {
    // useWorktree/openPR/worktreeChangesExpected are locked for this task type;
    // a per-app override must not smuggle them into the action bag.
    const [target] = resolveSyncTargets([
      { id: 'a', name: 'App A', repoPath: '/repos/a', taskTypeOverrides: { 'repo-sync': { taskMetadata: { useWorktree: true, openPR: true, syncPush: false } } } }
    ]);
    expect(target.actions.useWorktree).toBeUndefined();
    expect(target.actions.openPR).toBeUndefined();
    expect(target.actions.syncPush).toBe(false);
  });

  it('tolerates a missing app list', () => {
    expect(resolveSyncTargets(null)).toEqual([]);
  });
});
