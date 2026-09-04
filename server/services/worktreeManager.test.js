import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// Mock the git exec boundary so addWorktreeWithRetry's retry loop is testable
// without touching a real repo. Pure helpers below don't call execGit, so the
// mock is inert for them.
const execGitMock = vi.fn();
vi.mock('../lib/execGit.js', () => ({ execGit: (...args) => execGitMock(...args) }));

// removeWorktree's branch-preservation path needs the fs + git boundaries stubbed:
// it checks the worktree dir exists, reads `git status`, and (for the resume gate)
// asks git.js for the default branch. Pure helpers don't touch these.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  realpathSync: vi.fn((p) => p),
}));
vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  // adoptWorktree ensures the worktrees root exists before moving a tree into it.
  mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./instances.js', () => ({ ensureInstanceId: vi.fn().mockResolvedValue('instance-1') }));
const getDefaultBranchMock = vi.fn().mockResolvedValue('main');
const isBranchMergedIntoMock = vi.fn().mockResolvedValue(false);
vi.mock('./git.js', () => ({
  getDefaultBranch: (...args) => getDefaultBranchMock(...args),
  isBranchMergedInto: (...args) => isBranchMergedIntoMock(...args),
}));

const {
  shouldRefuseDefaultBranchMerge,
  isHumanClaimWorktree,
  classifyWorktreeDirt,
  isGitLockError,
  addWorktreeWithRetry,
  isPreexistingRefError,
  isBranchCheckedOutElsewhereError,
  removeWorktree,
  adoptWorktree,
  findAdoptableWorktreeForBranch,
  createWorktree,
  createPersistentWorktree,
  listWorktrees,
} = await import('./worktreeManager.js');
const { isPathInsideDir } = await import('../lib/fileUtils.js');
const { worktreeOwnershipReason } = await import('../lib/worktreeOwnership.js');
const { win32 } = await import('path');
const { existsSync } = await import('fs');
const { PATHS } = await import('../lib/fileUtils.js');

/**
 * Tests for the worktree manager service.
 * Tests the pure logic (branch naming, path construction) without actual git operations.
 */

describe('Worktree Branch Naming', () => {
  function buildBranchName(taskId, agentId, planId) {
    return planId
      ? `cos/${taskId}/${planId}/${agentId}`
      : `cos/${taskId}/${agentId}`;
  }

  it('should include task ID and agent ID', () => {
    const branch = buildBranchName('task-abc123', 'agent-12345678');
    expect(branch).toBe('cos/task-abc123/agent-12345678');
  });

  it('should use cos/ prefix for namespacing', () => {
    const branch = buildBranchName('task-xyz', 'agent-abcd');
    expect(branch.startsWith('cos/')).toBe(true);
  });

  it('should handle system task IDs', () => {
    const branch = buildBranchName('sys-001', 'agent-00000001');
    expect(branch).toBe('cos/sys-001/agent-00000001');
  });

  it('should splice planId between taskId and agentId when provided', () => {
    const branch = buildBranchName('task-abc', 'agent-xyz', 'extract-resolve-provider-helper');
    expect(branch).toBe('cos/task-abc/extract-resolve-provider-helper/agent-xyz');
  });

  it('should fall back to the two-segment form when planId is empty', () => {
    expect(buildBranchName('task-abc', 'agent-xyz', '')).toBe('cos/task-abc/agent-xyz');
    expect(buildBranchName('task-abc', 'agent-xyz', undefined)).toBe('cos/task-abc/agent-xyz');
  });
});

describe('Worktree Path Construction', () => {
  function buildWorktreePath(baseDir, agentId) {
    return `${baseDir}/${agentId}`;
  }

  it('should create path under worktrees directory', () => {
    const path = buildWorktreePath('/data/cos/worktrees', 'agent-12345678');
    expect(path).toBe('/data/cos/worktrees/agent-12345678');
  });

  it('should use agent ID as directory name', () => {
    const path = buildWorktreePath('/data/cos/worktrees', 'agent-abcdef12');
    expect(path.endsWith('agent-abcdef12')).toBe(true);
  });
});

describe('Worktree Porcelain Parsing', () => {
  function parseWorktreeList(stdout) {
    const worktrees = [];
    let current = {};

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9) };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7);
      } else if (line === 'bare') {
        current.bare = true;
      } else if (line === 'detached') {
        current.detached = true;
      }
    }
    if (current.path) worktrees.push(current);

    return worktrees;
  }

  it('should parse single worktree', () => {
    const output = `worktree /Users/user/project
HEAD abc1234567890
branch refs/heads/main
`;
    const result = parseWorktreeList(output);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/Users/user/project');
    expect(result[0].head).toBe('abc1234567890');
    expect(result[0].branch).toBe('refs/heads/main');
  });

  it('should parse multiple worktrees', () => {
    const output = `worktree /Users/user/project
HEAD abc1234567890
branch refs/heads/main

worktree /data/cos/worktrees/agent-12345678
HEAD def9876543210
branch refs/heads/cos/task-abc/agent-12345678
`;
    const result = parseWorktreeList(output);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('/Users/user/project');
    expect(result[1].path).toBe('/data/cos/worktrees/agent-12345678');
    expect(result[1].branch).toBe('refs/heads/cos/task-abc/agent-12345678');
  });

  it('should handle detached HEAD', () => {
    const output = `worktree /Users/user/project
HEAD abc1234567890
detached
`;
    const result = parseWorktreeList(output);
    expect(result).toHaveLength(1);
    expect(result[0].detached).toBe(true);
  });

  it('should handle empty output', () => {
    const result = parseWorktreeList('');
    expect(result).toHaveLength(0);
  });
});

describe('Persistent Worktree Path Construction', () => {
  function buildPersistentWorktreePath(worktreesDir, featureAgentId) {
    return join(worktreesDir, '..', 'feature-agents', featureAgentId, 'worktree');
  }

  it('should place worktree under feature-agents directory', () => {
    const path = buildPersistentWorktreePath('/data/cos/worktrees', 'fa-abc12345');
    expect(path).toContain('feature-agents');
    expect(path).toContain('fa-abc12345');
    expect(path.endsWith('worktree')).toBe(true);
  });

  it('should be separate from regular worktrees directory', () => {
    const regularPath = '/data/cos/worktrees/agent-12345678';
    const persistentPath = buildPersistentWorktreePath('/data/cos/worktrees', 'fa-abc12345');
    const normalized = persistentPath.replace(/\\/g, '/');
    expect(normalized).not.toContain('/worktrees/fa-');
    expect(regularPath).not.toContain('feature-agents');
  });

  it('should use feature agent ID as parent directory', () => {
    const result = buildPersistentWorktreePath('/data/cos/worktrees', 'fa-12345678');
    const normalized = result.replace(/\\/g, '/');
    expect(normalized).toContain('/fa-12345678/');
  });
});

describe('Uncommitted Changes Detection', () => {
  // Mirrors the dirty-file detection logic in removeWorktree
  function hasDirtyFiles(porcelainOutput) {
    return porcelainOutput.trim().length > 0;
  }

  it('should detect modified files as dirty', () => {
    expect(hasDirtyFiles(' M src/index.js')).toBe(true);
  });

  it('should detect untracked files as dirty', () => {
    expect(hasDirtyFiles('?? newfile.js')).toBe(true);
  });

  it('should detect staged files as dirty', () => {
    expect(hasDirtyFiles('A  newfile.js')).toBe(true);
  });

  it('should detect multiple dirty files', () => {
    expect(hasDirtyFiles(' M src/a.js\n M src/b.js\n?? src/c.js')).toBe(true);
  });

  it('should return false for clean worktree', () => {
    expect(hasDirtyFiles('')).toBe(false);
  });

  it('should return false for whitespace-only output', () => {
    expect(hasDirtyFiles('  \n  ')).toBe(false);
  });
});

describe('Auto-generated Lockfile Detection', () => {
  // Mirrors the lockfile-discard logic in removeWorktree
  const AUTO_GENERATED_LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

  function allAutoGenerated(porcelainOutput) {
    const dirtyList = porcelainOutput.trim().split('\n').filter(l => l.trim());
    if (dirtyList.length === 0) return false;
    return dirtyList.every(line =>
      AUTO_GENERATED_LOCKFILES.some(f => line.endsWith(f))
    );
  }

  // Mirrors the path extraction regex in removeWorktree
  function extractPath(porcelainLine) {
    return porcelainLine.replace(/^\s*\S+\s+/, '');
  }

  it('should identify package-lock.json as auto-generated', () => {
    expect(allAutoGenerated(' M autofixer/package-lock.json')).toBe(true);
  });

  it('should identify yarn.lock as auto-generated', () => {
    expect(allAutoGenerated(' M yarn.lock')).toBe(true);
  });

  it('should identify pnpm-lock.yaml as auto-generated', () => {
    expect(allAutoGenerated(' M pnpm-lock.yaml')).toBe(true);
  });

  it('should identify nested lockfiles as auto-generated', () => {
    expect(allAutoGenerated(' M client/package-lock.json')).toBe(true);
  });

  it('should identify multiple lockfiles as all auto-generated', () => {
    expect(allAutoGenerated(' M package-lock.json\n M server/package-lock.json')).toBe(true);
  });

  it('should return false when real files are mixed with lockfiles', () => {
    expect(allAutoGenerated(' M package-lock.json\n M src/index.js')).toBe(false);
  });

  it('should return false for non-lockfile changes', () => {
    expect(allAutoGenerated(' M src/index.js')).toBe(false);
  });

  it('should return false for empty output', () => {
    expect(allAutoGenerated('')).toBe(false);
  });

  it('should extract path from porcelain line with leading space', () => {
    expect(extractPath(' M autofixer/package-lock.json')).toBe('autofixer/package-lock.json');
  });

  it('should extract path from trimmed porcelain line (first line after .trim())', () => {
    expect(extractPath('M autofixer/package-lock.json')).toBe('autofixer/package-lock.json');
  });

  it('should extract path from untracked file', () => {
    expect(extractPath('?? package-lock.json')).toBe('package-lock.json');
  });
});

describe('classifyWorktreeDirt (real exported helper)', () => {
  it('reports clean for empty / whitespace-only porcelain', () => {
    expect(classifyWorktreeDirt('')).toEqual({ clean: true, lockfileOnly: false, lockfilePaths: [], realChangePaths: [], hasRealChanges: false });
    expect(classifyWorktreeDirt('  \n  ').clean).toBe(true);
    expect(classifyWorktreeDirt(null).clean).toBe(true);
  });

  it('flags real (non-lockfile) changes', () => {
    const r = classifyWorktreeDirt(' M src/index.js');
    expect(r.clean).toBe(false);
    expect(r.hasRealChanges).toBe(true);
    expect(r.lockfileOnly).toBe(false);
  });

  it('recognizes a lockfile-only working tree and extracts paths', () => {
    const r = classifyWorktreeDirt(' M package-lock.json\n M client/package-lock.json');
    expect(r.lockfileOnly).toBe(true);
    expect(r.hasRealChanges).toBe(false);
    expect(r.lockfilePaths).toEqual(['package-lock.json', 'client/package-lock.json']);
  });

  it('treats mixed lockfile + real changes as real changes', () => {
    const r = classifyWorktreeDirt(' M package-lock.json\n M src/app.js');
    expect(r.lockfileOnly).toBe(false);
    expect(r.hasRealChanges).toBe(true);
  });

  // realChangePaths feeds branch reconciliation's supersession check — it
  // intersects them with what the default branch changed since the branch
  // diverged, so the paths must be bare and lockfile-free.
  it('extracts the non-lockfile paths, excluding lockfiles and untangling renames', () => {
    const r = classifyWorktreeDirt(' M package-lock.json\n M src/app.js\n?? src/new.js\nR  src/old.js -> src/renamed.js');
    expect(r.realChangePaths).toEqual(['src/app.js', 'src/new.js', 'src/renamed.js']);
    expect(r.realChangePaths).not.toContain('package-lock.json');
  });

  it('handles a trimmed first line (no leading status space)', () => {
    const r = classifyWorktreeDirt('M yarn.lock');
    expect(r.lockfileOnly).toBe(true);
    expect(r.lockfilePaths).toEqual(['yarn.lock']);
  });

  it('can ignore a consumed completion sentinel without hiding real work', () => {
    expect(classifyWorktreeDirt('?? .agent-done', { ignoredPaths: ['.agent-done'] }).clean).toBe(true);

    const r = classifyWorktreeDirt('?? .agent-done\n M src/index.js', { ignoredPaths: ['.agent-done'] });
    expect(r.hasRealChanges).toBe(true);
    expect(r.realChangePaths).toEqual(['src/index.js']);
  });

  it('ignores the per-agent sentinel name without hiding real work', () => {
    // The sentinel filename carries the agent id (see doneSentinelName), so the
    // caller passes THIS run's name — not a wildcard that would also swallow a
    // sibling agent's sentinel.
    const ignoredPaths = ['.agent-done', '.agent-done-agent-1'];
    expect(classifyWorktreeDirt('?? .agent-done-agent-1', { ignoredPaths }).clean).toBe(true);

    const r = classifyWorktreeDirt('?? .agent-done-agent-1\n M src/index.js', { ignoredPaths });
    expect(r.hasRealChanges).toBe(true);
    expect(r.realChangePaths).toEqual(['src/index.js']);
    // Another agent's sentinel is NOT ignored — an unrelated run's file in a
    // shared checkout is still dirt this caller must not silently discard.
    expect(classifyWorktreeDirt('?? .agent-done-agent-2', { ignoredPaths }).clean).toBe(false);
  });

  // PortOS materializes the public-review bundle INTO the worktree it hands a
  // reviewer model and never commits it. Subtracted for EVERY caller rather than
  // passed in per call: counted as work, it made `removeWorktree` preserve the
  // tree, `reapMergedWorktrees` hold it, and branch-reconcile spend a coordinator
  // run per pass concluding "no real work product, a human should discard it".
  it('subtracts PortOS runtime scratch with no ignoredPaths from the caller', () => {
    expect(classifyWorktreeDirt('?? PORTOS_PUBLIC_REVIEW_INPUT.json').clean).toBe(true);
    // Untracked directories arrive collapsed to their root…
    expect(classifyWorktreeDirt('?? .portos-public-review/').clean).toBe(true);
    // …and expanded to files under -uall.
    expect(classifyWorktreeDirt('?? .portos-public-review/PR-42.patch').clean).toBe(true);
    expect(classifyWorktreeDirt('?? PORTOS_PUBLIC_REVIEW_INPUT.json\n?? .portos-public-review/').clean).toBe(true);
  });

  it('still reports real work sitting beside the scratch', () => {
    const r = classifyWorktreeDirt('?? PORTOS_PUBLIC_REVIEW_INPUT.json\n M src/index.js');
    expect(r.hasRealChanges).toBe(true);
    expect(r.realChangePaths).toEqual(['src/index.js']);
    // A sibling that merely shares the prefix is real work, not scratch.
    expect(classifyWorktreeDirt('?? .portos-public-review-notes.md').hasRealChanges).toBe(true);
  });
});

describe('Broken Worktree Detection', () => {
  // Mirrors the rev-parse validation logic in removeWorktree that prevents
  // git status from resolving to a parent repo (e.g., PortOS) when the
  // worktree's .git file is missing. Mirrors the realpath-normalization too
  // so symlink-equivalent paths (/var <-> /private/var) don't false-positive.
  function isBrokenWorktree(detectedToplevel, expectedWorktreePath, realpathFn = p => p) {
    if (!detectedToplevel) return false;
    if (detectedToplevel === expectedWorktreePath) return false;
    try {
      return realpathFn(detectedToplevel) !== realpathFn(expectedWorktreePath);
    } catch {
      return detectedToplevel !== expectedWorktreePath;
    }
  }

  it('should detect worktree resolving to parent repo as broken', () => {
    const worktreePath = '/data/cos/worktrees/agent-abc';
    const detectedToplevel = '/Users/user/PortOS'; // parent repo
    expect(isBrokenWorktree(detectedToplevel, worktreePath)).toBe(true);
  });

  it('should not flag valid worktree as broken', () => {
    const worktreePath = '/data/cos/worktrees/agent-abc';
    const detectedToplevel = '/data/cos/worktrees/agent-abc';
    expect(isBrokenWorktree(detectedToplevel, worktreePath)).toBe(false);
  });

  it('should not flag as broken when rev-parse fails (null)', () => {
    const worktreePath = '/data/cos/worktrees/agent-abc';
    expect(isBrokenWorktree(null, worktreePath)).toBeFalsy();
  });

  it('should treat symlink-equivalent paths as the same worktree', () => {
    // e.g. /var/folders/... resolves to /private/var/folders/... on macOS
    const worktreePath = '/var/data/cos/worktrees/agent-abc';
    const detectedToplevel = '/private/var/data/cos/worktrees/agent-abc';
    const realpathFn = p => p.replace(/^\/var\//, '/private/var/');
    expect(isBrokenWorktree(detectedToplevel, worktreePath, realpathFn)).toBe(false);
  });
});

// Git reports POSIX separators on every platform, while PATHS.worktrees is
// backslash-separated on Windows — so a bare `startsWith` matched nothing there:
// `cleanupOrphanedWorktrees` skipped every CoS worktree and `reapMergedWorktrees`
// filed them all as `unmanaged-location`, which is why the daily line read
// "reaped 0 merged + 0 orphaned" on a Windows install with orphans on disk.
// These pin the properties the module RELIES ON from the shared helpers, so a
// change to either one surfaces here rather than as silent dead cleanup.
describe('git-vs-PortOS path comparison', () => {
  it('matches a git-reported POSIX path against a Windows worktrees dir', () => {
    // win32-only: `resolvePath` folds `/` to `\` on Windows, which is what makes
    // the mixed-separator comparison work. On POSIX a backslash is a legal
    // filename character, so this case can't arise and isn't asserted.
    if (process.platform !== 'win32') return;
    expect(isPathInsideDir('H:\\repo\\data\\cos\\worktrees', 'H:/repo/data/cos/worktrees/agent-abc')).toBe(true);
  });

  it('does not match a sibling directory that merely shares a prefix', () => {
    expect(isPathInsideDir('/repo/data/cos/worktrees', '/repo/data/cos/worktrees-old/agent-abc')).toBe(false);
  });

  it('does not treat the directory itself as being under itself', () => {
    expect(isPathInsideDir('/repo/data/cos/worktrees', '/repo/data/cos/worktrees')).toBe(false);
  });

  it('reads the agent id off either separator', () => {
    expect(win32.basename('H:/repo/data/cos/worktrees/agent-abc')).toBe('agent-abc');
    expect(win32.basename('H:\\repo\\data\\cos\\worktrees\\agent-abc')).toBe('agent-abc');
  });
});

describe('Orphaned Worktree Detection', () => {
  function findOrphanedWorktrees(worktrees, worktreesDir, activeAgentIds) {
    return worktrees.filter((wt) => worktreeOwnershipReason({
      path: wt.path,
      locked: wt.locked,
      activeAgentIds,
      roots: [{ path: worktreesDir, requireAgentId: true }],
      requireKnownLiveness: true,
    }) === null);
  }

  it('should identify worktrees without active agents', () => {
    const worktrees = [
      { path: '/project', branch: 'refs/heads/main' },
      { path: '/data/cos/worktrees/agent-aaa', branch: 'refs/heads/cos/task-1/agent-aaa' },
      { path: '/data/cos/worktrees/agent-bbb', branch: 'refs/heads/cos/task-2/agent-bbb' }
    ];
    const activeIds = new Set(['agent-aaa']);
    const orphans = findOrphanedWorktrees(worktrees, '/data/cos/worktrees', activeIds);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].path).toContain('agent-bbb');
  });

  it('should not include the main worktree', () => {
    const worktrees = [
      { path: '/project', branch: 'refs/heads/main' },
      { path: '/data/cos/worktrees/agent-aaa', branch: 'refs/heads/cos/task-1/agent-aaa' }
    ];
    const orphans = findOrphanedWorktrees(worktrees, '/data/cos/worktrees', new Set());

    expect(orphans).toHaveLength(1);
    expect(orphans[0].path).not.toBe('/project');
  });

  it('should return empty when all worktrees have active agents', () => {
    const worktrees = [
      { path: '/data/cos/worktrees/agent-aaa', branch: 'refs/heads/cos/task-1/agent-aaa' }
    ];
    const activeIds = new Set(['agent-aaa']);
    const orphans = findOrphanedWorktrees(worktrees, '/data/cos/worktrees', activeIds);

    expect(orphans).toHaveLength(0);
  });

  it('never flags a human-driven /claim worktree as orphaned', () => {
    const worktrees = [
      { path: '/data/cos/worktrees/agent-bbb', branch: 'refs/heads/cos/task-2/agent-bbb' },
      { path: '/data/cos/worktrees/claim-extract-compare-helpers', branch: 'refs/heads/claim/extract-compare-helpers' }
    ];
    // No active agents at all — the dead CoS agent IS an orphan, but the claim
    // worktree must be left alone (it's owned by /claim's own cleanup).
    const orphans = findOrphanedWorktrees(worktrees, '/data/cos/worktrees', new Set());

    expect(orphans).toHaveLength(1);
    expect(orphans[0].path).toContain('agent-bbb');
    expect(orphans.some(o => o.path.includes('claim-'))).toBe(false);
  });
});

describe('isHumanClaimWorktree', () => {
  it('is true for /claim worktree dir names', () => {
    expect(isHumanClaimWorktree('claim-extract-compare-helpers')).toBe(true);
    expect(isHumanClaimWorktree('claim-codex5-onboarding-capability-map')).toBe(true);
  });

  it('is false for CoS agent worktree dir names', () => {
    expect(isHumanClaimWorktree('agent-1a2b3c4d')).toBe(false);
    expect(isHumanClaimWorktree('cos-task-xyz')).toBe(false);
  });

  it('is false for non-string / empty input (fail safe)', () => {
    expect(isHumanClaimWorktree(undefined)).toBe(false);
    expect(isHumanClaimWorktree(null)).toBe(false);
    expect(isHumanClaimWorktree('')).toBe(false);
  });
});

describe('Default-Branch Merge Gate (defense-in-depth)', () => {
  it('allows merge when source repo HEAD matches the default branch', () => {
    expect(shouldRefuseDefaultBranchMerge('main', 'main')).toBe(false);
  });

  it('allows merge for a non-main default (e.g. master, dev)', () => {
    expect(shouldRefuseDefaultBranchMerge('master', 'master')).toBe(false);
    expect(shouldRefuseDefaultBranchMerge('develop', 'develop')).toBe(false);
  });

  it('refuses merge when HEAD is on a TUI claim branch', () => {
    expect(shouldRefuseDefaultBranchMerge('claim/extend-syncorchestrator', 'main')).toBe(true);
  });

  it('refuses merge when HEAD is on any feature branch', () => {
    expect(shouldRefuseDefaultBranchMerge('feature/x', 'main')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge('fix/bug-123', 'main')).toBe(true);
  });

  it('refuses merge when HEAD is on another in-flight CoS branch', () => {
    expect(shouldRefuseDefaultBranchMerge('cos/task-abc/agent-xyz', 'main')).toBe(true);
  });

  it('refuses merge when default branch detection failed (fail closed)', () => {
    expect(shouldRefuseDefaultBranchMerge('main', null)).toBe(true);
    expect(shouldRefuseDefaultBranchMerge('main', '')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge('main', undefined)).toBe(true);
  });

  it('refuses merge when source repo HEAD is unknown', () => {
    expect(shouldRefuseDefaultBranchMerge('', 'main')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge(null, 'main')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge(undefined, 'main')).toBe(true);
  });

  it('refuses merge when both inputs are missing', () => {
    expect(shouldRefuseDefaultBranchMerge(null, null)).toBe(true);
  });
});

describe('isGitLockError (worktree add lock detection, #2193)', () => {
  it('recognizes the canonical worktree/index lock errors', () => {
    expect(isGitLockError("fatal: Unable to create '/repo/.git/worktrees/agent-x/index.lock': File exists.")).toBe(true);
    expect(isGitLockError('fatal: could not lock config file .git/config: File exists')).toBe(true);
    expect(isGitLockError('error: cannot lock ref')).toBe(true);
    expect(isGitLockError('Another git process seems to be running in this repository')).toBe(true);
  });

  it('does NOT flag permanent failures — including "already exists", which is NOT lock contention', () => {
    // These fast-fail identically on every retry, so matching them would just
    // burn the retry budget and spam misleading "lock contention" logs (#2193).
    expect(isGitLockError("fatal: invalid reference: origin/nope")).toBe(false);
    expect(isGitLockError('fatal: not a valid object name')).toBe(false);
    expect(isGitLockError("fatal: '/repo/data/cos/worktrees/agent-x' already exists")).toBe(false);
    expect(isGitLockError("fatal: a branch named 'cos/task/agent' already exists")).toBe(false);
    expect(isGitLockError('')).toBe(false);
    expect(isGitLockError(undefined)).toBe(false);
  });

  // A per-file checkout failure is NOT lock contention. It reads "unable to
  // create", but it only happens after git has written most of the tree — so
  // retrying it costs a full checkout per attempt. With the 10-minute add
  // timeout that is 4 × 10 min of head-of-line blocking on the per-repo queue,
  // for an error that never clears. This is the Windows AV-filter failure mode
  // the long timeout exists to tolerate, so the two must not compound.
  it('does NOT flag a per-file checkout failure as lock contention', () => {
    expect(isGitLockError('error: unable to create file some/deep/path.js: Permission denied')).toBe(false);
    expect(isGitLockError('error: unable to create symlink foo/bar: Operation not permitted')).toBe(false);
  });

  it('still flags a genuine lock-FILE creation failure', () => {
    expect(isGitLockError("fatal: Unable to create '/repo/.git/config.lock': File exists")).toBe(true);
  });
});

// Windows git emits CRLF, and a bare split('\n') leaves a trailing \r on every
// parsed value. That is invisible on Linux and silently breaks the reaper on
// Windows: the path and branch carry the \r so containment and equality match
// nothing, and the flag lines stop comparing equal so bare/detached/locked/
// prunable all read false. It failed a real Windows CI job for hours while every
// Linux run stayed green, so the contract is pinned against BOTH line endings.
describe('listWorktrees line endings', () => {
  beforeEach(() => { execGitMock.mockReset(); });

  const PORCELAIN = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/wt',
    'HEAD def456',
    'branch refs/heads/feature',
    'locked',
    'prunable',
    '',
  ];

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('parses %s porcelain identically', async (_label, eol) => {
    execGitMock.mockResolvedValueOnce({ stdout: PORCELAIN.join(eol), stderr: '', exitCode: 0 });

    const worktrees = await listWorktrees('/repo');

    expect(worktrees).toHaveLength(2);
    // No stray \r anywhere — these values are compared against filesystem paths
    // and branch names, where a trailing carriage return matches nothing.
    expect(worktrees[0]).toMatchObject({ path: '/repo', head: 'abc123', branch: 'refs/heads/main' });
    expect(worktrees[1]).toMatchObject({
      path: '/repo/.claude/worktrees/wt',
      head: 'def456',
      branch: 'refs/heads/feature',
      locked: true,
      prunable: true,
    });
  });
});

describe('addWorktreeWithRetry (lock-contention retry, #2193)', () => {
  beforeEach(() => {
    execGitMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves without retrying on first-attempt success', async () => {
    execGitMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    await addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  // See WORKTREE_ADD_TIMEOUT_MS for why 30s was not enough.
  it('gives the add far more than execGit\'s 30s default, since it writes a full checkout', async () => {
    execGitMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    await addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    const [, , options] = execGitMock.mock.calls[0];
    expect(options?.timeout).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('does NOT retry a timeout — git is still running and would collide with itself', async () => {
    execGitMock.mockRejectedValueOnce(new Error('git command timed out after 600s: git worktree add -b cos/t/a /wt origin/main'));
    await expect(addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/t/a', '/wt', 'origin/main'], '/repo'))
      .rejects.toThrow(/timed out/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  it('retries a lock error then succeeds', async () => {
    execGitMock
      .mockRejectedValueOnce(new Error("Unable to create '/repo/.git/index.lock': File exists"))
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const p = addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    await vi.runAllTimersAsync();
    await p;
    expect(execGitMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the max attempts on persistent lock contention', async () => {
    execGitMock.mockRejectedValue(new Error('cannot lock ref'));
    const p = addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    const assertion = expect(p).rejects.toThrow(/cannot lock ref/);
    await vi.runAllTimersAsync();
    await assertion;
    // WORKTREE_ADD_MAX_ATTEMPTS === 4
    expect(execGitMock).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry a non-lock (permanent) error', async () => {
    execGitMock.mockRejectedValueOnce(new Error('fatal: invalid reference: origin/nope'));
    await expect(addWorktreeWithRetry(['worktree', 'add', '/wt', 'origin/nope'], '/repo'))
      .rejects.toThrow(/invalid reference/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an "already exists" precondition failure', async () => {
    execGitMock.mockRejectedValueOnce(new Error("fatal: a branch named 'cos/task/agent' already exists"));
    await expect(addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/task/agent', '/wt', 'main'], '/repo'))
      .rejects.toThrow(/already exists/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the FIRST attempt error so a retry-induced "already exists" cannot mask the real cause', async () => {
    // Attempt 1 creates the branch then fails on a lock error; attempt 2 then
    // fails with a self-inflicted "branch already exists". The final rejection
    // must carry the ORIGINAL lock error so orphan cleanup still runs (#2193).
    execGitMock
      .mockRejectedValueOnce(new Error('error: cannot lock ref (attempt 1 created the branch)'))
      .mockRejectedValueOnce(new Error("fatal: a branch named 'cos/task/agent' already exists"));
    const settled = addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/task/agent', '/wt', 'main'], '/repo').catch(e => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err.message).toMatch(/already exists/);
    expect(err.firstAttemptError.message).toMatch(/cannot lock ref/);
    expect(execGitMock).toHaveBeenCalledTimes(2);
  });

  it('sets firstAttemptError to the sole error when the first attempt is non-retryable', async () => {
    const only = new Error("fatal: a branch named 'cos/task/agent' already exists");
    execGitMock.mockRejectedValueOnce(only);
    const err = await addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/task/agent', '/wt', 'main'], '/repo').catch(e => e);
    expect(err.firstAttemptError).toBe(only);
  });
});

describe('isPreexistingRefError (orphan-cleanup guard, #2193)', () => {
  it('is true ONLY for a pre-existing BRANCH (git created nothing → skip cleanup)', () => {
    expect(isPreexistingRefError("fatal: a branch named 'cos/task/agent' already exists")).toBe(true);
    expect(isPreexistingRefError("fatal: a branch named 'main' already exists.")).toBe(true);
  });

  it('is FALSE for an occupied worktree PATH — git already created the branch there, so it IS an orphan to clean up', () => {
    expect(isPreexistingRefError("fatal: '/repo/data/cos/worktrees/agent-x' already exists")).toBe(false);
  });

  it('is false for lock contention and other failures (add may have left an orphan)', () => {
    expect(isPreexistingRefError('error: cannot lock ref')).toBe(false);
    expect(isPreexistingRefError('fatal: invalid reference')).toBe(false);
    expect(isPreexistingRefError('')).toBe(false);
    expect(isPreexistingRefError(undefined)).toBe(false);
  });
});

describe('isBranchCheckedOutElsewhereError (branch-busy pause gate)', () => {
  it('matches git\'s wording for a branch held by another worktree, old and new', () => {
    // Current git.
    expect(isBranchCheckedOutElsewhereError(
      "fatal: 'cos/task-x/agent-y' is already used by worktree at '/repo/data/cos/worktrees/agent-y'"
    )).toBe(true);
    // Pre-2.30 wording.
    expect(isBranchCheckedOutElsewhereError(
      "fatal: 'cos/task-x/agent-y' is already checked out at '/repo/data/cos/worktrees/agent-y'"
    )).toBe(true);
  });

  it('does NOT match the other "already exists" failures — those are permanent', () => {
    // An occupied worktree DIRECTORY is not a branch another tree is holding;
    // pausing on it would wait out a cooldown that can never clear it.
    expect(isBranchCheckedOutElsewhereError("fatal: '/repo/data/cos/worktrees/agent-x' already exists")).toBe(false);
    expect(isBranchCheckedOutElsewhereError("fatal: a branch named 'cos/task/agent' already exists")).toBe(false);
    expect(isBranchCheckedOutElsewhereError('error: cannot lock ref')).toBe(false);
    expect(isBranchCheckedOutElsewhereError('fatal: invalid reference: origin/nope')).toBe(false);
    expect(isBranchCheckedOutElsewhereError('')).toBe(false);
    expect(isBranchCheckedOutElsewhereError(undefined)).toBe(false);
  });

  it('stays out of the in-process add retry — that budget is sized for lock contention', () => {
    expect(isGitLockError("fatal: 'b' is already used by worktree at '/repo/wt'")).toBe(false);
  });
});

describe('findAdoptableWorktreeForBranch (take over the tree that holds the branch)', () => {
  const REPO = '/repo';
  const BRANCH = 'cos/task-x/agent-y';

  // `git worktree list --porcelain`: the primary checkout first, then whatever
  // entries a test names.
  function scriptWorktrees(entries) {
    execGitMock.mockReset();
    const stdout = [
      `worktree ${REPO}`, 'HEAD abc123', 'branch refs/heads/main', '',
      ...entries.flatMap(e => [
        `worktree ${e.path}`, 'HEAD def456',
        e.branch ? `branch ${e.branch}` : 'detached',
        ...(e.locked ? ['locked'] : []), ''
      ])
    ].join('\n');
    execGitMock.mockResolvedValue({ stdout, stderr: '' });
  }

  const cosTree = (agentId) => join(PATHS.worktrees, agentId);

  it('finds the CoS worktree holding the branch', async () => {
    scriptWorktrees([{ path: cosTree('agent-y'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH))
      .toEqual({ path: cosTree('agent-y'), agentId: 'agent-y' });
  });

  it('returns null when nothing holds the branch', async () => {
    scriptWorktrees([{ path: cosTree('agent-z'), branch: 'refs/heads/cos/other/agent-z' }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  // Adoption MOVES the directory, so a holder PortOS doesn't own is never a
  // candidate — taking the user's own checkout is the branch-jacking this
  // codebase guards against everywhere else.
  it('refuses the primary checkout, and any tree outside the managed root', async () => {
    scriptWorktrees([{ path: '/repo/../elsewhere/tree', branch: `refs/heads/${BRANCH}` }]);
    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();

    // The repo root itself, checked out on the branch.
    execGitMock.mockResolvedValue({
      stdout: `worktree ${REPO}\nHEAD abc\nbranch refs/heads/${BRANCH}\n`, stderr: ''
    });
    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  it('refuses a human /claim worktree — the claim flow owns its cleanup', async () => {
    scriptWorktrees([{ path: cosTree('claim-issue-42'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  it('refuses a non-agent directory in the managed root', async () => {
    scriptWorktrees([{ path: cosTree('next-issue-42'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  it('refuses a tree whose agent is still running — it is mid-edit in there', async () => {
    scriptWorktrees([{ path: cosTree('agent-y'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH, {
      activeAgentIds: new Set(['agent-y'])
    })).toBeNull();
  });

  it('refuses a locked worktree whatever else is true of it', async () => {
    scriptWorktrees([{ path: cosTree('agent-y'), branch: `refs/heads/${BRANCH}`, locked: true }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  it('returns null rather than throwing when the listing fails', async () => {
    execGitMock.mockReset();
    execGitMock.mockRejectedValue(new Error('not a git repository'));

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
    expect(await findAdoptableWorktreeForBranch(REPO, '')).toBeNull();
    expect(await findAdoptableWorktreeForBranch('', BRANCH)).toBeNull();
  });
});

describe('removeWorktree branch preservation for resume (#3167)', () => {
  // Routes each git invocation this path makes to a scripted answer, keyed on the
  // subcommand, so a test only has to state what it cares about instead of
  // ordering every call. The preserve/delete decision itself comes from the
  // mocked `isBranchMergedInto` (see the ./git.js mock at the top of this file).
  function scriptGit({ porcelain = '' } = {}) {
    execGitMock.mockReset();
    execGitMock.mockImplementation((args) => {
      const [sub] = args;
      if (sub === 'rev-parse' && args[1] === '--show-toplevel') {
        // Empty stdout → `detectedToplevel` is falsy, so removeWorktree SKIPS its
        // broken-worktree check rather than taking that early-return branch (which
        // deletes the branch itself and would mask what these tests assert).
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (sub === 'status') return Promise.resolve({ stdout: porcelain, stderr: '', exitCode: 0 });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
  }

  const calledWith = (subcommandArgs) =>
    execGitMock.mock.calls.some(([args]) => JSON.stringify(args) === JSON.stringify(subcommandArgs));

  beforeEach(() => {
    getDefaultBranchMock.mockResolvedValue('main');
    // mockReset (not just mockResolvedValue): the opt-in test asserts the merged
    // check was NOT consulted, so recorded calls must not leak in from a prior test.
    isBranchMergedIntoMock.mockReset();
    isBranchMergedIntoMock.mockResolvedValue(false);
    scriptGit();
  });

  it('KEEPS the branch when it is not yet merged into the default branch', async () => {
    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/preserved/i);
  });

  // Patch-equivalence matters here: PortOS merges with `--rebase`, so a landed
  // branch has new SHAs. `isBranchMergedInto` is what sees through that — a bare
  // `rev-list --count` would report it ahead and preserve a merged branch forever.
  it('DELETES the branch once it is merged (including rebase/squash-merged)', async () => {
    isBranchMergedIntoMock.mockResolvedValue(true);

    await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
  });

  it('fails CLOSED — keeps the branch when the merged check cannot be determined', async () => {
    isBranchMergedIntoMock.mockRejectedValue(new Error('unknown revision'));

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/preserved/i);
  });

  it('is opt-in: without the flag the no-merge path still deletes an unmerged branch', async () => {
    await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
    // The resume gate never consulted the merged check for THIS branch.
    expect(isBranchMergedIntoMock).not.toHaveBeenCalledWith('/repo', 'cos/task-1/agent-x', 'main');
  });

  // The bare "uncommitted changes detected" message left the user unable to tell
  // real abandoned work from a transient read of a worktree already being removed
  // — and the worktree is gone by the time anyone looks. Name the paths.
  it('NAMES the dirty paths in the preserved-worktree warning', async () => {
    scriptGit({ porcelain: ' M server/services/foo.js\n?? notes.md' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(false);
    expect(result.warnings.join(' ')).toContain('server/services/foo.js');
    expect(result.warnings.join(' ')).toContain('notes.md');
  });

  it('removes a completed worktree whose only dirt is the consumed per-agent sentinel', async () => {
    scriptGit({ porcelain: '?? .agent-done-agent-x' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('removes a completed worktree whose only dirt is the consumed sentinel', async () => {
    scriptGit({ porcelain: '?? .agent-done' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('preserves real work while excluding the completion sentinel from the warning', async () => {
    scriptGit({ porcelain: '?? .agent-done\n M src/index.js' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(false);
    expect(result.warnings.join(' ')).toContain('src/index.js');
    expect(result.warnings.join(' ')).not.toContain('.agent-done');
  });

  it('caps the named paths so a broad sweep cannot flood the notification', async () => {
    scriptGit({ porcelain: Array.from({ length: 9 }, (_, i) => ` M src/f${i}.js`).join('\n') });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    const warning = result.warnings.join(' ');
    expect(warning).toContain('src/f0.js');
    expect(warning).toContain('(+4 more)');
    expect(warning).not.toContain('src/f8.js');
  });
});

describe('adoptWorktree — resuming an interrupted run in its own worktree', () => {
  const WORKTREES = PATHS.worktrees;
  const DEAD_TREE = join(WORKTREES, 'agent-dead');
  const NEW_TREE = join(WORKTREES, 'agent-new');

  // The dead run's tree is on disk; the retry's destination is not.
  function scriptPaths({ source = true, target = false } = {}) {
    existsSync.mockImplementation((p) => {
      if (p === DEAD_TREE) return source;
      if (p === NEW_TREE) return target;
      return true;
    });
  }

  beforeEach(() => {
    execGitMock.mockReset();
    execGitMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    scriptPaths();
  });

  afterEach(() => { existsSync.mockReturnValue(true); });

  // Renaming to the retry's own id keeps `<worktrees>/<agentId>` == "the agent that
  // owns this tree" — the invariant cleanupOrphanedWorktrees reaps on. Adopted in
  // place, the live retry's worktree would be reaped out from under it.
  it('moves the dead run’s tree to the retrying agent’s directory', async () => {
    const result = await adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead');

    // Third arg is the long add/move timeout — a move relocates a whole checkout,
    // so it needs the same headroom as the add it shares a wrapper with.
    expect(execGitMock).toHaveBeenCalledWith(
      ['worktree', 'move', DEAD_TREE, NEW_TREE],
      '/repo',
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(result).toMatchObject({
      worktreePath: NEW_TREE, branchName: 'cos/task-1/agent-dead',
      existingBranch: true, adopted: true
    });
  });

  it('returns null (caller starts clean) when the leftover tree is gone', async () => {
    scriptPaths({ source: false });

    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead')).resolves.toBeNull();
    expect(execGitMock).not.toHaveBeenCalled();
  });

  it('refuses to clobber an occupied destination', async () => {
    scriptPaths({ target: true });

    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead')).resolves.toBeNull();
    expect(execGitMock).not.toHaveBeenCalled();
  });

  // git refuses to move a locked worktree or one with initialized submodules —
  // never throw at the spawn path, just decline so the caller builds a fresh tree.
  it('returns null rather than throwing when git refuses the move', async () => {
    execGitMock.mockRejectedValue(new Error('working trees containing submodules cannot be moved'));

    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead')).resolves.toBeNull();
  });

  it('is a no-op when the tree already sits at the destination', async () => {
    scriptPaths({ source: true, target: true });

    const result = await adoptWorktree('agent-new', '/repo', NEW_TREE, 'cos/task-1/agent-dead');

    expect(execGitMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ worktreePath: NEW_TREE, adopted: true });
  });

  // removeWorktree discards lockfile churn rather than preserving it, and the
  // resume prompt tells the retry that everything uncommitted is its own work to
  // finish and commit — so an adopted tree carrying only a stale `npm install`
  // lockfile bump would ship it in the PR.
  it('discards lockfile-only churn in the adopted tree', async () => {
    execGitMock.mockImplementation((args) => Promise.resolve(
      args[0] === 'status'
        ? { stdout: ' M package-lock.json\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 }
    ));

    await adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead');

    expect(execGitMock).toHaveBeenCalledWith(['checkout', '--', 'package-lock.json'], NEW_TREE);
  });

  it('keeps every uncommitted change when the tree holds real work too', async () => {
    execGitMock.mockImplementation((args) => Promise.resolve(
      args[0] === 'status'
        ? { stdout: ' M package-lock.json\n M server/services/thing.js\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 }
    ));

    await adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead');

    expect(execGitMock).not.toHaveBeenCalledWith(expect.arrayContaining(['checkout']), expect.anything());
  });

  it('returns null on incomplete input instead of guessing', async () => {
    await expect(adoptWorktree(null, '/repo', DEAD_TREE, 'b')).resolves.toBeNull();
    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, null)).resolves.toBeNull();
    expect(execGitMock).not.toHaveBeenCalled();
  });
});

describe('createWorktree upstream safety (#4172)', () => {
  // Wiring-level coverage: that the branch invariant itself HOLDS against real
  // git is proved in lib/branchUpstreamGuard.test.js (real repos, real config).
  // What can only be checked here is that createWorktree actually reaches for
  // it — the flag on the add, and the guard on the result.
  // `originHasBranch` / `forkRemoteUrl` / `forkRefResolves` script the three
  // lookups the existingBranch resolve order makes, so a test can put the tree
  // in the fork-PR state: no local branch, no origin ref, a fork that answers.
  function scriptGit({ mergeReadings = [], originHasBranch = true, forkRemoteUrl = null, forkRefResolves = true } = {}) {
    const readings = [...mergeReadings];
    execGitMock.mockReset();
    execGitMock.mockImplementation((args) => {
      if (args[0] === 'config' && args[1] === '--get' && /\.merge$/.test(args[2] || '')) {
        const answer = readings.length ? readings.shift() : '';
        // exitCode 1 mirrors `git config --get` on an unset key, which the guard
        // must read as "no upstream" rather than as an error.
        return Promise.resolve({ stdout: answer, stderr: '', exitCode: answer ? 0 : 1 });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        const ref = args[2] || '';
        const resolves = ref.startsWith('origin/') ? originHasBranch : forkRefResolves;
        return Promise.resolve({ stdout: resolves ? 'deadbeef' : '', stderr: '', exitCode: resolves ? 0 : 1 });
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return forkRemoteUrl
          ? Promise.resolve({ stdout: `${forkRemoteUrl}\n`, stderr: '', exitCode: 0 })
          : Promise.resolve({ stdout: '', stderr: 'No such remote', exitCode: 2 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
  }

  const argsFor = (predicate) => execGitMock.mock.calls.map(([args]) => args).filter(predicate);

  beforeEach(() => {
    getDefaultBranchMock.mockResolvedValue('main');
    scriptGit();
  });

  it('creates the branch with --no-track so git cannot record refs/heads/main as its upstream', async () => {
    await createWorktree('agent-1', '/repo', 'task-1');

    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('--no-track');
    // The flag has to precede -b: it configures the branch being created.
    expect(add.indexOf('--no-track')).toBeLessThan(add.indexOf('-b'));
  });

  it('drops an upstream that still points at the default branch', async () => {
    // An older git, or a repo whose config re-tracks despite the flag: the first
    // read finds `main`, the guard unsets, the re-read confirms.
    scriptGit({ mergeReadings: ['refs/heads/main'] });

    await createWorktree('agent-2', '/repo', 'task-2');

    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(1);
  });

  it('leaves a healthy branch untouched', async () => {
    await createWorktree('agent-3', '/repo', 'task-3');

    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(0);
  });

  it('undoes the add when the upstream cannot be made safe, instead of stranding a worktree', async () => {
    // The guard throws AFTER `worktree add` succeeded, so without an undo the
    // caller sees a failed create while a registered worktree and an orphan
    // branch stay on disk — the debris cleanupOrphanBranch prevents on the add.
    scriptGit({ mergeReadings: ['refs/heads/main', 'refs/heads/main'] });

    await expect(createWorktree('agent-5', '/repo', 'task-5')).rejects.toThrow(/still resolves to/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'remove')).toHaveLength(1);
    expect(argsFor(a => a[0] === 'branch' && a[1] === '-D')).toHaveLength(1);
  });

  it('does NOT delete the branch when undoing an existingBranch attach', async () => {
    // That branch pre-dates this add and may hold real commits — same
    // distinction cleanupOrphanBranch draws.
    scriptGit({ mergeReadings: ['refs/heads/main', 'refs/heads/main'] });

    await expect(createWorktree('agent-6', '/repo', 'task-6', { existingBranch: 'cos/task-0/agent-0' }))
      .rejects.toThrow(/still resolves to/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'remove')).toHaveLength(1);
    expect(argsFor(a => a[0] === 'branch' && a[1] === '-D')).toHaveLength(0);
  });

  it('attaches a FORK PR head from a fork remote and leaves its upstream on the fork (#6064)', async () => {
    // The regression: a fork PR's head has no `origin/<branch>` at all, so
    // before this every "work on this PR's branch" path threw at workspace prep
    // for exactly the PRs external contributors open.
    scriptGit({ originHasBranch: false });

    await createWorktree('agent-fork', '/repo', 'task-fork', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote' && a[1] === 'add'))
      .toEqual([['remote', 'add', 'fork-contributor', 'https://github.com/contributor/widget.git']]);
    expect(argsFor(a => a[0] === 'fetch' && a[1] === 'fork-contributor'))
      .toEqual([['fetch', 'fork-contributor', 'contributor/fix-thing']]);
    // The start point is the whole point: it is what makes the branch track the
    // CONTRIBUTOR's fork, so a later `git push` lands there and not on upstream.
    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toEqual([
      'worktree', 'add', '-B', 'contributor/fix-thing',
      join(PATHS.worktrees, 'agent-fork'), 'fork-contributor/contributor/fix-thing',
    ]);
    // ...and the #4172 guard must not "repair" that fork upstream away.
    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(0);
  });

  it('re-points a stale fork remote instead of duplicating it or failing', async () => {
    // The remote is named from the OWNER so re-runs reuse it; a contributor who
    // renamed or moved their fork leaves the recorded URL stale.
    scriptGit({ originHasBranch: false, forkRemoteUrl: 'https://github.com/contributor/old-name.git' });

    await createWorktree('agent-fork2', '/repo', 'task-fork2', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote' && a[1] === 'add')).toHaveLength(0);
    expect(argsFor(a => a[0] === 'remote' && a[1] === 'set-url'))
      .toEqual([['remote', 'set-url', 'fork-contributor', 'https://github.com/contributor/widget.git']]);
  });

  it('leaves a fork remote alone when it already points at the right URL', async () => {
    scriptGit({ originHasBranch: false, forkRemoteUrl: 'https://github.com/contributor/widget.git' });

    await createWorktree('agent-fork3', '/repo', 'task-fork3', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote' && (a[1] === 'add' || a[1] === 'set-url'))).toHaveLength(0);
    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('fork-contributor/contributor/fix-thing');
  });

  it('still throws today\'s exact error when no forkHead is supplied', async () => {
    // The fork path is a third FALLBACK: a caller that passes no coordinates
    // must get the pre-#6064 behavior, message included.
    scriptGit({ originHasBranch: false });

    await expect(createWorktree('agent-fork4', '/repo', 'task-fork4', { existingBranch: 'contributor/fix-thing' }))
      .rejects.toThrow('Cannot attach worktree to contributor/fix-thing: branch missing locally and origin/contributor/fix-thing unavailable');

    expect(argsFor(a => a[0] === 'remote')).toHaveLength(0);
    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'add')).toHaveLength(0);
  });

  it('falls back to the origin-only error when the fork fetch leaves no ref', async () => {
    // A fetch that "succeeded" but produced no remote-tracking ref must not send
    // `worktree add` at a start point git would resolve somewhere else.
    scriptGit({ originHasBranch: false, forkRefResolves: false });

    await expect(createWorktree('agent-fork5', '/repo', 'task-fork5', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    })).rejects.toThrow(/branch missing locally and origin\/contributor\/fix-thing unavailable/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'add')).toHaveLength(0);
  });

  it('never consults the fork when origin already has the branch', async () => {
    await createWorktree('agent-fork6', '/repo', 'task-fork6', {
      existingBranch: 'shared/branch',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote')).toHaveLength(0);
    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('origin/shared/branch');
  });

  it('checks the re-attached branch of an existingBranch worktree too', async () => {
    // Branches created before this fix keep their bad upstream; a review-loop
    // agent re-attaching to one must not inherit a push aimed at main.
    scriptGit({ mergeReadings: ['refs/heads/main'] });

    await createWorktree('agent-4', '/repo', 'task-4', { existingBranch: 'cos/task-0/agent-0' });

    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(1);
  });

  // The persistent feature-agent tree needs its own coverage, not just the CoS
  // one: it lives OUTSIDE `WORKTREES_DIR`, so neither `cleanupOrphanedWorktrees`
  // nor `reapMergedWorktrees` reaps it, and its only caller does not catch. A
  // stranded tree there blocks every retry with "already exists" until a human
  // prunes it, so the undo has to happen here rather than being left to a sweeper.
  it('creates the persistent feature-agent branch with --no-track too', async () => {
    await createPersistentWorktree('fa-1', '/repo', 'feature/x', 'main');

    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('--no-track');
  });

  it('undoes the persistent add when the upstream cannot be made safe', async () => {
    scriptGit({ mergeReadings: ['refs/heads/main', 'refs/heads/main'] });

    await expect(createPersistentWorktree('fa-2', '/repo', 'feature/y', 'main'))
      .rejects.toThrow(/still resolves to/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'remove')).toHaveLength(1);
    expect(argsFor(a => a[0] === 'branch' && a[1] === '-D')).toHaveLength(1);
  });
});
