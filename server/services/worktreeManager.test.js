import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// Mock the git exec boundary so addWorktreeWithRetry's retry loop is testable
// without touching a real repo. Pure helpers below don't call execGit, so the
// mock is inert for them.
const execGitMock = vi.fn();
vi.mock('../lib/execGit.js', () => ({ execGit: (...args) => execGitMock(...args) }));

const {
  shouldRefuseDefaultBranchMerge,
  isHumanClaimWorktree,
  classifyWorktreeDirt,
  isGitLockError,
  addWorktreeWithRetry,
} = await import('./worktreeManager.js');

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
    expect(classifyWorktreeDirt('')).toEqual({ clean: true, lockfileOnly: false, lockfilePaths: [], hasRealChanges: false });
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

  it('handles a trimmed first line (no leading status space)', () => {
    const r = classifyWorktreeDirt('M yarn.lock');
    expect(r.lockfileOnly).toBe(true);
    expect(r.lockfilePaths).toEqual(['yarn.lock']);
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

describe('Orphaned Worktree Detection', () => {
  function findOrphanedWorktrees(worktrees, worktreesDir, activeAgentIds) {
    return worktrees.filter(wt => {
      if (!wt.path.startsWith(worktreesDir)) return false;
      const agentId = wt.path.split('/').pop();
      // Mirror the real cleanup guard: human-driven `/claim` worktrees are
      // never CoS orphans.
      if (isHumanClaimWorktree(agentId)) return false;
      return !activeAgentIds.has(agentId);
    });
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
    expect(isGitLockError("fatal: '.git/worktrees/foo' already exists")).toBe(true);
  });

  it('does NOT flag genuine, non-retryable failures', () => {
    expect(isGitLockError("fatal: invalid reference: origin/nope")).toBe(false);
    expect(isGitLockError('fatal: not a valid object name')).toBe(false);
    expect(isGitLockError('')).toBe(false);
    expect(isGitLockError(undefined)).toBe(false);
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
});
