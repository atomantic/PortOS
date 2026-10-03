import { beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { detectConflicts, extractKeywords } from './taskConflict.js';

vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));

const workspace = '/example/workspace';
let porcelain;

beforeEach(() => {
  porcelain = '';
  existsSync.mockReset().mockImplementation(path => path === join(workspace, '.git'));
  execGit.mockReset().mockImplementation(async (args, cwd) => {
    expect(cwd).toBe(workspace);
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n' };
    if (args.join(' ') === 'status --porcelain') return { stdout: porcelain };
    throw new Error('Unexpected git subcommand');
  });
});

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

describe('detectConflicts', () => {
  describe('No conflict scenarios', () => {
    it('should return proceed when no agents are active in workspace', async () => {
      const task = { description: 'Fix login button', metadata: {} };
      const result = await detectConflicts(task, workspace, []);

      expect(result).toEqual({
        hasConflict: false,
        reason: 'no-active-agents-in-workspace',
        conflictingAgents: [],
        recommendation: 'proceed'
      });
    });

    it('should return proceed when agents are in different workspaces', async () => {
      const task = { description: 'Fix login', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: '/other/workspace', taskDescription: 'Fix login' } }
      ];
      const result = await detectConflicts(task, workspace, agents);

      expect(result).toEqual({
        hasConflict: false,
        reason: 'no-active-agents-in-workspace',
        conflictingAgents: [],
        recommendation: 'proceed'
      });
    });

    it('should skip conflict detection for non-git repos', async () => {
      const task = { description: 'Run something', metadata: {} };
      existsSync.mockReturnValue(false);
      const result = await detectConflicts(task, workspace, []);

      expect(execGit).not.toHaveBeenCalled();

      expect(result).toEqual({
        hasConflict: false,
        reason: 'not-a-git-repo',
        conflictingAgents: [],
        recommendation: 'skip'
      });
    });
  });

  describe('Conflict scenarios', () => {
    it('should detect conflict when workspace has uncommitted changes', async () => {
      const task = { description: 'Add feature', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'Working on stuff' } }
      ];
      porcelain = ' M server/index.js\nM  client/App.jsx\n?? notes.txt\n';
      const result = await detectConflicts(task, workspace, agents);

      expect(result.modifiedFiles).toEqual(['server/index.js', 'client/App.jsx', 'notes.txt']);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('workspace-has-uncommitted-changes');
      expect(result.recommendation).toBe('worktree');
      expect(result.conflictingAgents).toEqual(['agent-1']);
    });

    it('should detect overlap when tasks target the same app', async () => {
      const task = { description: 'Improve dashboard', metadata: { app: 'my-app' } };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'Review my-app', app: 'my-app' } }
      ];
      const result = await detectConflicts(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('concurrent-agents-likely-overlap');
      expect(result.recommendation).toBe('worktree');
      expect(result.conflictingAgents).toEqual(['agent-1']);
    });

    it('should detect overlap when descriptions share keywords', async () => {
      const task = { description: 'refactor authentication middleware logic', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'improve authentication middleware performance' } }
      ];
      const result = await detectConflicts(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('concurrent-agents-likely-overlap');
      expect(result.recommendation).toBe('worktree');
      expect(result.conflictingAgents).toEqual(['agent-1']);
    });

    it('should still flag conflict for agents in same workspace with no keyword overlap', async () => {
      const task = { description: 'update readme file', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'deploy kubernetes cluster' } }
      ];
      const result = await detectConflicts(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('concurrent-agents-in-same-workspace');
      expect(result.recommendation).toBe('worktree');
      expect(result.conflictingAgents).toEqual(['agent-1']);
    });
  });

  describe('Multiple agents', () => {
    it('should identify all conflicting agents', async () => {
      const task = { description: 'work on auth', metadata: {} };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'fix auth module' } },
        { id: 'agent-2', workspacePath: workspace, taskDescription: 'test auth flows' },
        { id: 'agent-3', metadata: { workspacePath: '/other', taskDescription: 'something else' } }
      ];
      const result = await detectConflicts(task, workspace, agents);

      expect(result.hasConflict).toBe(true);
      expect(result.reason).toBe('concurrent-agents-in-same-workspace');
      expect(result.recommendation).toBe('worktree');
      expect(result.conflictingAgents).toEqual(['agent-1', 'agent-2']);
    });
  });
});
