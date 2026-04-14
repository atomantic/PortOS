import { describe, it, expect } from 'vitest';
import { join } from 'path';

/**
 * Tests for the worktree manager service.
 * Tests the pure logic (branch naming, path construction) without actual git operations.
 */

describe('Worktree Branch Naming', () => {
  function buildBranchName(taskId, agentId) {
    return `cos/${taskId}/${agentId}`;
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
});
