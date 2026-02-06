import { describe, it, expect } from 'vitest';

/**
 * Tests for the task conflict detection service.
 * We test the pure logic inline to avoid complex mocking of child_process/fs.
 */

// Inline extractKeywords logic for unit testing
function extractKeywords(text) {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'be', 'as',
    'are', 'was', 'were', 'been', 'has', 'have', 'had', 'do', 'does',
    'not', 'no', 'can', 'will', 'should', 'may', 'task', 'fix', 'add',
    'update', 'change', 'make', 'use', 'new', 'all', 'any', 'each'
  ]);

  return text
    .replace(/[^a-z0-9\s-_/.]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

// Inline conflict analysis logic for testing without git/fs dependencies
function analyzeConflict(task, workspacePath, activeAgents, options = {}) {
  const { isGitRepo = true, modifiedFiles = [] } = options;

  if (!isGitRepo) {
    return { hasConflict: false, reason: 'not-a-git-repo', conflictingAgents: [], recommendation: 'skip' };
  }

  const sameWorkspaceAgents = activeAgents.filter(agent => {
    const agentWorkspace = agent.metadata?.workspacePath || agent.workspacePath;
    return agentWorkspace === workspacePath;
  });

  if (sameWorkspaceAgents.length === 0) {
    return { hasConflict: false, reason: 'no-active-agents-in-workspace', conflictingAgents: [], recommendation: 'proceed' };
  }

  if (modifiedFiles.length > 0) {
    return {
      hasConflict: true,
      reason: 'workspace-has-uncommitted-changes',
      conflictingAgents: sameWorkspaceAgents.map(a => a.id),
      modifiedFiles,
      recommendation: 'worktree'
    };
  }

  const taskDesc = (task.description || '').toLowerCase();
  const taskApp = task.metadata?.app;

  const overlappingAgents = sameWorkspaceAgents.filter(agent => {
    const agentDesc = (agent.metadata?.taskDescription || agent.taskDescription || '').toLowerCase();
    const agentApp = agent.metadata?.app || agent.app;

    if (taskApp && agentApp && taskApp === agentApp) return true;

    const taskKeywords = extractKeywords(taskDesc);
    const agentKeywords = extractKeywords(agentDesc);
    const overlap = taskKeywords.filter(k => agentKeywords.includes(k));
    return overlap.length >= 2;
  });

  if (overlappingAgents.length > 0) {
    return {
      hasConflict: true,
      reason: 'concurrent-agents-likely-overlap',
      conflictingAgents: overlappingAgents.map(a => a.id),
      recommendation: 'worktree'
    };
  }

  return {
    hasConflict: true,
    reason: 'concurrent-agents-in-same-workspace',
    conflictingAgents: sameWorkspaceAgents.map(a => a.id),
    recommendation: 'worktree'
  };
}

describe('extractKeywords', () => {
  it('should extract meaningful words and filter stop words', () => {
    const keywords = extractKeywords('fix the authentication bug in login component');
    expect(keywords).not.toContain('the');
    expect(keywords).toContain('authentication');
    expect(keywords).toContain('bug');
    expect(keywords).toContain('login');
    expect(keywords).toContain('component');
  });

  it('should filter short words (<=2 chars)', () => {
    const keywords = extractKeywords('a go to do it');
    expect(keywords).toHaveLength(0);
  });

  it('should handle file paths', () => {
    const keywords = extractKeywords('update server/services/cos.js');
    expect(keywords).toContain('server/services/cos.js');
  });

  it('should return empty for empty string', () => {
    expect(extractKeywords('')).toHaveLength(0);
  });
});

describe('Conflict Detection Logic', () => {
  const workspace = '/home/user/portos';

  describe('No conflict scenarios', () => {
    it('should return proceed when no agents are active in workspace', () => {
      const task = { description: 'Fix login button', metadata: {} };
      const result = analyzeConflict(task, workspace, []);

      expect(result.hasConflict).toBe(false);
      expect(result.recommendation).toBe('proceed');
    });

    it('should return proceed when agents are in different workspaces', () => {
      const task = { description: 'Fix login', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: '/other/workspace', taskDescription: 'Fix login' } }
      ];
      const result = analyzeConflict(task, workspace, agents);

      expect(result.hasConflict).toBe(false);
      expect(result.recommendation).toBe('proceed');
    });

    it('should skip conflict detection for non-git repos', () => {
      const task = { description: 'Run something', metadata: {} };
      const result = analyzeConflict(task, workspace, [], { isGitRepo: false });

      expect(result.hasConflict).toBe(false);
      expect(result.recommendation).toBe('skip');
    });
  });

  describe('Conflict scenarios', () => {
    it('should detect conflict when workspace has uncommitted changes', () => {
      const task = { description: 'Add feature', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'Working on stuff' } }
      ];
      const result = analyzeConflict(task, workspace, agents, {
        modifiedFiles: ['server/index.js', 'client/App.jsx']
      });

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('workspace-has-uncommitted-changes');
      expect(result.recommendation).toBe('worktree');
      expect(result.conflictingAgents).toContain('agent-1');
    });

    it('should detect overlap when tasks target the same app', () => {
      const task = { description: 'Improve dashboard', metadata: { app: 'my-app' } };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'Review my-app', app: 'my-app' } }
      ];
      const result = analyzeConflict(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('concurrent-agents-likely-overlap');
      expect(result.recommendation).toBe('worktree');
    });

    it('should detect overlap when descriptions share keywords', () => {
      const task = { description: 'refactor authentication middleware logic', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'improve authentication middleware performance' } }
      ];
      const result = analyzeConflict(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('concurrent-agents-likely-overlap');
      expect(result.recommendation).toBe('worktree');
    });

    it('should still flag conflict for agents in same workspace with no keyword overlap', () => {
      const task = { description: 'update readme file', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'deploy kubernetes cluster' } }
      ];
      const result = analyzeConflict(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('concurrent-agents-in-same-workspace');
      expect(result.recommendation).toBe('worktree');
    });
  });

  describe('Multiple agents', () => {
    it('should identify all conflicting agents', () => {
      const task = { description: 'work on auth', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'fix auth module' } },
        { id: 'agent-2', metadata: { workspacePath: workspace, taskDescription: 'test auth flows' } },
        { id: 'agent-3', metadata: { workspacePath: '/other', taskDescription: 'something else' } }
      ];
      const result = analyzeConflict(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.conflictingAgents).toHaveLength(2);
      expect(result.conflictingAgents).toContain('agent-1');
      expect(result.conflictingAgents).toContain('agent-2');
      expect(result.conflictingAgents).not.toContain('agent-3');
    });
  });
});
