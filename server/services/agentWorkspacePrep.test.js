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
import { getAppWorkspace } from './agentPromptBuilder.js';

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

describe('prepareAgentWorkspace — workspace validation (#3180)', () => {
  // Both shapes used to fall through to the PortOS root, so the agent did its
  // work in the PortOS checkout instead of the user's app. A blocked task the
  // user can fix beats a wrong-repo commit they have to discover later.
  it('blocks when the task names an app that resolves to no repo path', async () => {
    getAppWorkspace.mockResolvedValue(null);
    const task = { id: 't-no-path', taskType: 'user', metadata: { app: 'primes' } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-np', task });
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toContain('primes');
    expect(r.reason).toContain('Repository Path');
  });

  it('blocks when the resolved workspace does not exist on disk', async () => {
    getAppWorkspace.mockResolvedValue('/definitely/not/a/real/repo/path');
    const task = { id: 't-missing', taskType: 'user', metadata: { app: 'primes' } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-ms', task });
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toContain('/definitely/not/a/real/repo/path');
  });

  it('blocks when the resolved workspace is a file, not a directory', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const file = join(mkdtempSync(join(tmpdir(), 'prep-')), 'a-file.txt');
    writeFileSync(file, 'x');
    getAppWorkspace.mockResolvedValue(file);
    const task = { id: 't-file', taskType: 'user', metadata: { app: 'primes' } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-f', task });
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toContain('not a directory');
  });

  // The repoPath field accepts a literal '~/...' — the CoS path must expand it
  // the same way the /runs path does, or every task for that app is blocked.
  it('expands a ~ repoPath instead of blocking it', async () => {
    const { homedir } = await import('os');
    getAppWorkspace.mockResolvedValue('~');
    const task = { id: 't-tilde', taskType: 'user', metadata: { app: 'primes', readOnly: true } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-t', task });
    expect(r.outcome).toBe('ready');
    expect(r.workspacePath).toBe(homedir());
  });

  it('proceeds when the app resolves to a real directory', async () => {
    getAppWorkspace.mockResolvedValue(process.cwd());
    const task = { id: 't-ok', taskType: 'user', metadata: { app: 'primes', readOnly: true } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-ok', task });
    expect(r.outcome).toBe('ready');
    expect(r.workspacePath).toBe(process.cwd());
  });
});
