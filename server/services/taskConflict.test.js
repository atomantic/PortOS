import { beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { detectConflicts } from './taskConflict.js';

vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));

const workspace = '/example/workspace';

beforeEach(() => {
  existsSync.mockReset().mockImplementation(path => path === join(workspace, '.git'));
  execGit.mockReset().mockImplementation(async (args, cwd) => {
    expect(cwd).toBe(workspace);
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n' };
    throw new Error('Unexpected git subcommand');
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
      expect(execGit).not.toHaveBeenCalled();
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
      const agents = [{ id: 'agent-1', metadata: { workspacePath: workspace } }];
      const result = await detectConflicts(task, workspace, agents);

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
    it('should recommend a worktree for an occupied checkout regardless of task prose', async () => {
      const task = { description: 'update readme file', metadata: { app: 'my-app' } };
      const agents = [
        { id: 'agent-1', metadata: { workspacePath: workspace, taskDescription: 'update readme file', app: 'my-app' } }
      ];
      const result = await detectConflicts(task, workspace, agents);

      expect(result).toEqual({
        hasConflict: true,
        reason: 'concurrent-agents-in-same-workspace',
        conflictingAgents: ['agent-1'],
        recommendation: 'worktree'
      });
      expect(execGit.mock.calls.map(c => c[0].join(' '))).toEqual(['rev-parse --is-inside-work-tree']);
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
