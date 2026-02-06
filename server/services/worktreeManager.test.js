import { describe, it, expect } from 'vitest';

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
