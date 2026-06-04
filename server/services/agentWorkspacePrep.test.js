/**
 * Tests for agentWorkspacePrep — the workspace-path + worktree/JIRA
 * provisioning extracted out of spawnAgentForTask.
 *
 * The contract these pin: the function returns a discriminated outcome
 * ('ready' | 'deferred' | 'blocked') so spawnAgentForTask can fire
 * cleanupOnError + the matching agent:deferred / agent:error event at the
 * call site (where the spawn-local dedup guard / lane / execution state
 * lives). A read-only task takes the fast path — no git pull, no worktree.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue({}),
  addTask: vi.fn().mockResolvedValue({}),
  getAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock('./apps.js', () => ({ getAppById: vi.fn().mockResolvedValue(null) }));
vi.mock('./git.js', () => ({
  ensureLatest: vi.fn(),
  fetchOrigin: vi.fn(),
  getRepoBranches: vi.fn().mockResolvedValue({ baseBranch: 'main' }),
  checkout: vi.fn(),
  createBranch: vi.fn(),
}));
vi.mock('./taskConflict.js', () => ({ detectConflicts: vi.fn().mockResolvedValue({ recommendation: 'proceed' }) }));
vi.mock('./worktreeManager.js', () => ({ createWorktree: vi.fn(), mergeBaseIntoFeatureWorktree: vi.fn() }));
vi.mock('./agentPromptBuilder.js', () => ({
  getAppWorkspace: vi.fn().mockResolvedValue('/repos/app-x'),
  getAppDataForTask: vi.fn().mockResolvedValue(null),
  createJiraTicketForTask: vi.fn(),
}));

import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { ensureLatest } from './git.js';
import { detectConflicts } from './taskConflict.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('prepareAgentWorkspace', () => {
  it('read-only task: returns ready with the shared workspace and skips the git pull', async () => {
    const task = { id: 't-ro', taskType: 'user', metadata: { readOnly: true } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-ro', task });
    expect(r.outcome).toBe('ready');
    expect(r.worktreeInfo).toBeNull();
    expect(r.jiraBranchName).toBeNull();
    expect(r.explicitWorktree).toBe(false);
    expect(ensureLatest).not.toHaveBeenCalled();
  });

  it('defers when the pre-task git pull hits an unresolvable conflict', async () => {
    ensureLatest.mockResolvedValue({ conflict: true, branch: 'feature/x', error: 'rebase failed' });
    const task = { id: 't-conflict', taskType: 'user', metadata: {} };
    const r = await prepareAgentWorkspace({ agentId: 'agent-c', task });
    expect(r.outcome).toBe('deferred');
    expect(r.deferReason).toBe('git-conflict');
    expect(r.branch).toBe('feature/x');
  });

  it('proceeds in the shared workspace when the pull is clean and no conflict is detected', async () => {
    ensureLatest.mockResolvedValue({ success: true, upToDate: true });
    const task = { id: 't-clean', taskType: 'user', metadata: {} };
    const r = await prepareAgentWorkspace({ agentId: 'agent-clean', task });
    expect(r.outcome).toBe('ready');
    expect(r.worktreeInfo).toBeNull();
    expect(detectConflicts).toHaveBeenCalled();
  });
});
