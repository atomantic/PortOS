import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock every dependency subAgentSpawner.js imports ---

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn()
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true })
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false)
}));

vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn(() => 'mock-uuid')
}));

vi.mock('./cos.js', () => ({
  cosEvents: { on: vi.fn(), emit: vi.fn() },
  registerAgent: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined),
  appendAgentOutput: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn().mockResolvedValue(undefined),
  addTask: vi.fn().mockResolvedValue(undefined),
  emitLog: vi.fn(),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAgent: vi.fn().mockResolvedValue(null)
}));

vi.mock('./appActivity.js', () => ({
  startAppCooldown: vi.fn(),
  markAppReviewCompleted: vi.fn()
}));

vi.mock('./cosRunnerClient.js', () => ({
  isRunnerAvailable: vi.fn(() => false),
  spawnAgentViaRunner: vi.fn(),
  terminateAgentViaRunner: vi.fn(),
  killAgentViaRunner: vi.fn(),
  getAgentStatsFromRunner: vi.fn(),
  initCosRunnerConnection: vi.fn(),
  onCosRunnerEvent: vi.fn(),
  getActiveAgentsFromRunner: vi.fn(() => []),
  getRunnerHealth: vi.fn()
}));

vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
  getAllProviders: vi.fn(() => [])
}));

vi.mock('./usage.js', () => ({
  recordSession: vi.fn(),
  recordMessages: vi.fn()
}));

vi.mock('./providerStatus.js', () => ({
  isProviderAvailable: vi.fn(() => true),
  markProviderUsageLimit: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getFallbackProvider: vi.fn(),
  getProviderStatus: vi.fn(),
  initProviderStatus: vi.fn()
}));

vi.mock('./promptService.js', () => ({
  buildPrompt: vi.fn()
}));

vi.mock('./agents.js', () => ({
  registerSpawnedAgent: vi.fn(),
  unregisterSpawnedAgent: vi.fn()
}));

vi.mock('./memoryRetriever.js', () => ({
  getMemorySection: vi.fn()
}));

vi.mock('./memoryExtractor.js', () => ({
  extractAndStoreMemories: vi.fn()
}));

vi.mock('./digital-twin.js', () => ({
  getDigitalTwinForPrompt: vi.fn()
}));

vi.mock('./taskLearning.js', () => ({
  suggestModelTier: vi.fn()
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn().mockResolvedValue({}),
  PATHS: {
    root: '/mock/root',
    cosAgents: '/mock/root/data/cos/agents',
    runs: '/mock/root/data/runs',
    worktrees: '/mock/root/data/cos/worktrees',
    data: '/mock/root/data',
    cos: '/mock/root/data/cos'
  }
}));

vi.mock('./apps.js', () => ({
  getAppById: vi.fn()
}));

vi.mock('./toolStateMachine.js', () => ({
  createToolExecution: vi.fn(),
  startExecution: vi.fn(),
  updateExecution: vi.fn(),
  completeExecution: vi.fn(),
  errorExecution: vi.fn(),
  getExecution: vi.fn(),
  getStats: vi.fn()
}));

vi.mock('./thinkingLevels.js', () => ({
  resolveThinkingLevel: vi.fn(),
  getModelForLevel: vi.fn(),
  isLocalPreferred: vi.fn(() => false)
}));

vi.mock('./executionLanes.js', () => ({
  determineLane: vi.fn(),
  acquire: vi.fn(() => ({ success: true })),
  release: vi.fn()
}));

vi.mock('./taskConflict.js', () => ({
  detectConflicts: vi.fn(() => [])
}));

vi.mock('./worktreeManager.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  cleanupOrphanedWorktrees: vi.fn()
}));

vi.mock('./jira.js', () => ({
  default: {}
}));

vi.mock('./git.js', () => ({
  push: vi.fn(),
  getRepoBranches: vi.fn(),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  createPR: vi.fn(),
  generatePRDescription: vi.fn(),
  deleteBranch: vi.fn().mockResolvedValue(undefined),
  requestCopilotReview: vi.fn().mockResolvedValue({ success: true }),
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: process.env, host: 'github.com', owner: null, account: null }),
  parsePullRequestUrl: vi.fn((url) => {
    // Minimal stand-in: extract host/owner/repo/number from GitHub PR URLs
    const match = url?.match?.(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:pull|merge_requests|-\/merge_requests)\/(\d+)/);
    if (!match) return null;
    return { host: match[1], owner: match[2], repo: match[3], number: Number(match[4]) };
  })
}));

vi.mock('./runner.js', () => ({
  executeApiRun: vi.fn(),
  executeCliRun: vi.fn(),
  createRun: vi.fn()
}));

// --- Import the function under test and the mocked dependencies ---

import { cleanupAgentWorktree, spawnMergeRecoveryTask, spawnReviewLoopFollowUp } from './subAgentSpawner.js';
import { getAgent, addTask } from './cos.js';
import { removeWorktree } from './worktreeManager.js';
import * as git from './git.js';

// Helper: build a mock agent state for worktree agents
function mockWorktreeAgent(overrides = {}) {
  return {
    metadata: {
      isWorktree: true,
      isPersistentWorktree: false,
      sourceWorkspace: '/mock/workspace',
      worktreeBranch: 'cos/task-abc123',
      workspacePath: '/mock/root/data/cos/worktrees/agent-1',
      ...overrides
    }
  };
}

describe('cleanupAgentWorktree - openPR path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: agent is a worktree agent with valid metadata
    getAgent.mockResolvedValue(mockWorktreeAgent());
    git.getRepoBranches.mockResolvedValue({ baseBranch: 'main', devBranch: null });
    // generatePRDescription returns a rich body from agent output summary
    git.generatePRDescription.mockImplementation(() =>
      Promise.resolve('Automated PR created by PortOS Chief of Staff.\n\n## Summary\n\nImplemented the requested feature with new API endpoints and UI components.')
    );
  });

  it('should run PR flow when openPR is true and success is true', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/1' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test task' });

    expect(git.push).toHaveBeenCalledWith('/mock/root/data/cos/worktrees/agent-1', 'cos/task-abc123');
    expect(git.createPR).toHaveBeenCalledWith('/mock/root/data/cos/worktrees/agent-1', {
      title: 'Test task',
      body: expect.stringContaining('Summary'),
      base: 'main',
      head: 'cos/task-abc123'
    });
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false });
  });

  it('should call removeWorktree with merge: false after successful push and PR', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/2' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true });

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith(
      'agent-1',
      '/mock/workspace',
      'cos/task-abc123',
      { merge: false }
    );
  });

  it('should preserve worktree when push fails (no removeWorktree call)', async () => {
    git.push.mockRejectedValue(new Error('push rejected'));

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test task' });

    expect(git.push).toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should preserve worktree when createPR returns { success: false }', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: false, error: 'PR already exists' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test task' });

    expect(git.createPR).toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should silently clean up worktree when createPR fails with "No commits between"', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: false, error: 'GraphQL: No commits between main and cos/task-abc123 (createPullRequest)' });

    const warnings = await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test task' });

    expect(git.createPR).toHaveBeenCalled();
    // Agent made no changes — delete remote branch and clean up silently without a warning
    expect(git.deleteBranch).toHaveBeenCalledWith('/mock/workspace', 'cos/task-abc123', { remote: true });
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false });
    expect(warnings).toHaveLength(0);
  });

  it('should use auto-merge path when openPR is false (success)', async () => {
    await cleanupAgentWorktree('agent-1', true, { openPR: false });

    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: true });
  });

  it('should use auto-merge path when openPR is not provided (defaults to false)', async () => {
    await cleanupAgentWorktree('agent-1', true);

    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: true });
  });

  it('should skip PR flow when openPR is true but success is false', async () => {
    await cleanupAgentWorktree('agent-1', false, { openPR: true });

    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    // Falls through to auto-merge path with merge: false (failure cleanup)
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false });
  });

  it('should use baseBranch as PR base (not devBranch, since worktrees are created from baseBranch)', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/3' });
    git.getRepoBranches.mockResolvedValue({ baseBranch: 'main', devBranch: 'develop' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test' });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      base: 'main'
    }));
  });

  it('should fall back to "main" when getRepoBranches fails', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/4' });
    git.getRepoBranches.mockRejectedValue(new Error('not a git repo'));

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test' });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      base: 'main'
    }));
  });

  it('should preserve worktree when createPR throws', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockRejectedValue(new Error('network error'));

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test' });

    // PR creation failed — worktree preserved for manual intervention
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should truncate long descriptions to 100 chars for PR title', async () => {
    const longDesc = 'A'.repeat(200);
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/5' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: longDesc });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: 'A'.repeat(100)
    }));
  });

  it('should use only first line of multiline description for PR title', async () => {
    const multilineDesc = '[Improvement: grace] Error Handling\n\nAnalyze the codebase:\n\nRepository: /Users/foo/grace';
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/7' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: multilineDesc });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: '[Improvement: grace] Error Handling'
    }));
  });

  it('should use default description when none provided', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/6' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: 'CoS automated task',
      body: expect.stringContaining('Chief of Staff')
    }));
  });

  // --- Early-exit guard tests ---

  it('should no-op when agent is not a worktree agent', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: false } });

    await cleanupAgentWorktree('agent-1', true, { openPR: true });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should no-op when agent state is null', async () => {
    getAgent.mockResolvedValue(null);

    await cleanupAgentWorktree('agent-1', true, { openPR: true });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should no-op for persistent worktree agents', async () => {
    getAgent.mockResolvedValue(mockWorktreeAgent({ isPersistentWorktree: true }));

    await cleanupAgentWorktree('agent-1', true, { openPR: true });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should no-op when sourceWorkspace or worktreeBranch is missing', async () => {
    getAgent.mockResolvedValue(mockWorktreeAgent({ sourceWorkspace: null }));

    await cleanupAgentWorktree('agent-1', true, { openPR: true });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  // --- requestCopilotReview flag tests (regression for the openPR && !reviewLoop bug) ---

  it('should request a Copilot review after PR creation when requestCopilotReview is true', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/7' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, requestCopilotReview: true, description: 'Test' });

    expect(git.requestCopilotReview).toHaveBeenCalledWith('/mock/root/data/cos/worktrees/agent-1', 'https://github.com/test/repo/pull/7');
  });

  it('should NOT request a Copilot review when requestCopilotReview is false', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/8' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, requestCopilotReview: false, description: 'Test' });

    expect(git.requestCopilotReview).not.toHaveBeenCalled();
  });

  it('should still create PR (not auto-merge) when both openPR and requestCopilotReview are true — regression', async () => {
    // Regression for the bug where `openPR: taskOpenPR && !taskReviewLoop` skipped
    // PR creation when both flags were set, causing auto-merge into main with no PR/review.
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/9' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, requestCopilotReview: true, description: 'Test' });

    expect(git.createPR).toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false });
  });

  it('should record warning but still complete cleanup when Copilot review request fails', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/10' });
    git.requestCopilotReview.mockResolvedValue({ success: false, error: 'gh exited with code 1' });

    const warnings = await cleanupAgentWorktree('agent-1', true, { openPR: true, requestCopilotReview: true, description: 'Test' });

    expect(warnings.some(w => w.includes('Copilot review request failed'))).toBe(true);
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('should NOT record a warning when Copilot review is skipped on a non-GitHub forge', async () => {
    // Regression: GitLab MRs would previously emit a Copilot review request failure
    // warning since the helper returned { success: false, error: '...GitHub-only' }.
    // The new contract: { success: true, skipped: true } → no warning, info-level log.
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://gitlab.com/group/proj/-/merge_requests/11' });
    git.requestCopilotReview.mockResolvedValue({ success: true, skipped: true });

    const warnings = await cleanupAgentWorktree('agent-1', true, { openPR: true, requestCopilotReview: true, description: 'Test' });

    expect(warnings.some(w => w.includes('Copilot review'))).toBe(false);
    expect(removeWorktree).toHaveBeenCalled();
  });

  // --- Review-loop follow-up spawn tests (the user-reported bug:
  //     "they are only handling one review loop and then finishing,
  //      they are not continuing the loop ... until ready to merge") ---

  it('should spawn a review-loop follow-up task after a successful Copilot review request on a GitHub PR', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/42' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-x' });

    await cleanupAgentWorktree('agent-1', true, {
      openPR: true,
      requestCopilotReview: true,
      description: 'Build the thing',
      originalTask: { id: 'task-orig', priority: 'HIGH', metadata: { app: 'sparsetree' }, description: 'Build the thing' }
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp, taskType, opts] = addTask.mock.calls[0];
    expect(taskType).toBe('internal');
    expect(opts).toEqual({ raw: true });
    expect(followUp.metadata.reviewLoopFollowUp).toBe(true);
    expect(followUp.metadata.reviewLoopPRUrl).toBe('https://github.com/test/repo/pull/42');
    expect(followUp.metadata.reviewLoopPRBranch).toBe('cos/task-abc123');
    expect(followUp.metadata.reviewLoopPRNumber).toBe(42);
    expect(followUp.metadata.reviewLoopPROwner).toBe('test');
    expect(followUp.metadata.reviewLoopPRRepo).toBe('repo');
    expect(followUp.metadata.existingBranch).toBe('cos/task-abc123');
    expect(followUp.metadata.useWorktree).toBe(true);
    expect(followUp.metadata.openPR).toBe(false); // must not chain another PR
    expect(followUp.metadata.reviewLoop).toBe(false); // must not chain another loop
    expect(followUp.metadata.sourceTaskId).toBe('task-orig');
    expect(followUp.metadata.sourceAgentId).toBe('agent-1');
    expect(followUp.priority).toBe('HIGH');
    expect(followUp.autoApproved).toBe(true);
  });

  it('should NOT spawn a review-loop follow-up when Copilot review request fails', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/43' });
    git.requestCopilotReview.mockResolvedValue({ success: false, error: 'gh exited 1' });

    await cleanupAgentWorktree('agent-1', true, {
      openPR: true, requestCopilotReview: true, description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    // No follow-up because the initial review never landed — nothing to wait on
    expect(addTask).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('should NOT spawn a review-loop follow-up on non-GitHub forges (Copilot is GitHub-only)', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://gitlab.com/group/proj/-/merge_requests/12' });
    git.requestCopilotReview.mockResolvedValue({ success: true, skipped: true });

    await cleanupAgentWorktree('agent-1', true, {
      openPR: true, requestCopilotReview: true, description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('should NOT spawn a review-loop follow-up when requestCopilotReview is false', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/44' });

    await cleanupAgentWorktree('agent-1', true, {
      openPR: true, requestCopilotReview: false, description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    expect(git.requestCopilotReview).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  // --- skipMerge tests for review-loop follow-up cleanup ---

  it('should pass merge: false in the auto-merge fallback when skipMerge is true (review-loop follow-up cleanup)', async () => {
    // The follow-up agent already merged via `gh pr merge`; re-merging the worktree
    // branch into source workspace would duplicate the squashed commits.
    await cleanupAgentWorktree('agent-1', true, { openPR: false, skipMerge: true });

    expect(removeWorktree).toHaveBeenCalledWith(
      'agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false }
    );
  });

  it('should still pass merge: true in the auto-merge fallback when skipMerge is false on success', async () => {
    await cleanupAgentWorktree('agent-1', true, { openPR: false, skipMerge: false });

    expect(removeWorktree).toHaveBeenCalledWith(
      'agent-1', '/mock/workspace', 'cos/task-abc123', { merge: true }
    );
  });
});

describe('spawnReviewLoopFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addTask.mockResolvedValue({ id: 'sys-rl-x' });
  });

  it('should not spawn when prUrl is missing', async () => {
    const result = await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1', originalTask: { id: 'task-1' },
      prUrl: null, prBranch: 'cos/x/agent-1', sourceWorkspace: '/ws'
    });
    expect(result).toBeNull();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('should not spawn when prBranch is missing', async () => {
    const result = await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1', originalTask: { id: 'task-1' },
      prUrl: 'https://github.com/o/r/pull/1', prBranch: null, sourceWorkspace: '/ws'
    });
    expect(result).toBeNull();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('should skip spawning for GitLab MR URLs (Copilot is GitHub-only)', async () => {
    const result = await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1', originalTask: { id: 'task-1' },
      prUrl: 'https://gitlab.com/group/proj/-/merge_requests/5', prBranch: 'feat/x', sourceWorkspace: '/ws'
    });
    expect(result).toBeNull();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('should default priority to MEDIUM when originalTask omits it', async () => {
    await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1',
      originalTask: { id: 'task-1', metadata: {}, description: 'X' },
      prUrl: 'https://github.com/o/r/pull/9', prBranch: 'cos/task-1/agent-1', sourceWorkspace: '/ws'
    });
    expect(addTask.mock.calls[0][0].priority).toBe('MEDIUM');
  });
});

describe('spawnMergeRecoveryTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addTask.mockResolvedValue({ id: 'task-recovery' });
  });

  it('should create a recovery task when merge failure warning is present', async () => {
    const warnings = ['Auto-merge failed for branch cos/task-abc123/agent-1 — branch preserved for manual recovery'];
    const task = { id: 'task-original', description: 'Fix deps', metadata: { app: 'sparsetree' } };

    await spawnMergeRecoveryTask(warnings, 'agent-1', task, 'SparseTree', '/mock/workspace');

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('[Recovery]'),
        priority: 'HIGH',
        app: 'sparsetree',
        context: expect.stringContaining('cos/task-abc123/agent-1'),
        useWorktree: false,
      }),
      'user'
    );
  });

  it('should include branch name and repo path in recovery context', async () => {
    const warnings = ['Auto-merge failed for branch feature/my-branch — branch preserved for manual recovery'];
    const task = { id: 'task-1', description: 'Original task', metadata: { app: 'myapp' } };

    await spawnMergeRecoveryTask(warnings, 'agent-1', task, 'MyApp', '/mock/workspace');

    const call = addTask.mock.calls[0];
    expect(call[0].context).toContain('feature/my-branch');
    expect(call[0].context).toContain('/mock/workspace');
    expect(call[0].context).toContain('agent-1');
    expect(call[0].description).toContain('feature/my-branch');
    expect(call[0].description).toContain('MyApp');
  });

  it('should not create a task when no merge failure warning exists', async () => {
    const warnings = ['Worktree cleanup failed: some other error'];

    await spawnMergeRecoveryTask(warnings, 'agent-1', {}, 'TestApp', '/mock/workspace');

    expect(addTask).not.toHaveBeenCalled();
  });

  it('should not create a task when warnings array is empty', async () => {
    await spawnMergeRecoveryTask([], 'agent-1', {}, 'TestApp', '/mock/workspace');

    expect(addTask).not.toHaveBeenCalled();
  });

  it('should not create a task when sourceWorkspace is undefined', async () => {
    const warnings = ['Auto-merge failed for branch cos/task-abc/agent-1 — branch preserved'];

    await spawnMergeRecoveryTask(warnings, 'agent-1', {}, 'TestApp', undefined);

    expect(addTask).not.toHaveBeenCalled();
  });

  it('should not create a task when sourceWorkspace is null', async () => {
    const warnings = ['Auto-merge failed for branch cos/task-abc/agent-1 — branch preserved'];

    await spawnMergeRecoveryTask(warnings, 'agent-1', {}, 'TestApp', null);

    expect(addTask).not.toHaveBeenCalled();
  });

  it('should handle addTask failure gracefully', async () => {
    addTask.mockRejectedValue(new Error('write failed'));
    const warnings = ['Auto-merge failed for branch cos/task-abc/agent-1 — branch preserved'];

    // Should not throw
    await spawnMergeRecoveryTask(warnings, 'agent-1', { metadata: {} }, 'TestApp', '/mock/workspace');
  });

  it('should use "unknown" for task description when not provided', async () => {
    const warnings = ['Auto-merge failed for branch cos/branch-1 — branch preserved'];

    await spawnMergeRecoveryTask(warnings, 'agent-1', { metadata: {} }, 'TestApp', '/mock/workspace');

    const call = addTask.mock.calls[0];
    expect(call[0].context).toContain('original task: unknown');
  });

  it('should create a PR recovery task when a PR creation failure warning is present', async () => {
    const warnings = ['PR creation failed for branch cos/task-xyz/agent-1: GraphQL: some error. Worktree preserved for manual PR creation.'];
    const task = { id: 'task-original', description: 'Add feature', metadata: { app: 'myapp' } };

    await spawnMergeRecoveryTask(warnings, 'agent-1', task, 'MyApp', '/mock/workspace');

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('[Recovery]'),
        priority: 'HIGH',
        app: 'myapp',
        context: expect.stringContaining('cos/task-xyz/agent-1'),
        useWorktree: false,
      }),
      'user'
    );
  });

  it('should include branch name and workspace in PR recovery context', async () => {
    const warnings = ['PR creation failed for branch feature/my-pr-branch: gh exited with code 1. Worktree preserved for manual PR creation.'];
    const task = { id: 'task-1', description: 'Original task', metadata: { app: 'myapp' } };

    await spawnMergeRecoveryTask(warnings, 'agent-1', task, 'MyApp', '/mock/workspace');

    const call = addTask.mock.calls[0];
    expect(call[0].context).toContain('feature/my-pr-branch');
    expect(call[0].context).toContain('/mock/workspace');
    expect(call[0].description).toContain('feature/my-pr-branch');
    expect(call[0].description).toContain('MyApp');
  });

  it('should not create a PR recovery task when sourceWorkspace is missing', async () => {
    const warnings = ['PR creation failed for branch cos/task-xyz/agent-1: some error. Worktree preserved for manual PR creation.'];

    await spawnMergeRecoveryTask(warnings, 'agent-1', {}, 'TestApp', null);

    expect(addTask).not.toHaveBeenCalled();
  });

  it('emits glab/MR commands when the source workspace is a GitLab repo', async () => {
    git.resolveForgeForRepo.mockResolvedValueOnce({ cli: 'glab', env: process.env, host: 'gitlab.com', owner: 'mygroup', account: null });

    const warnings = ['PR creation failed for branch feature/x: glab error. Worktree preserved for manual PR creation.'];
    const task = { id: 'task-gl', description: 'Add thing', metadata: { app: 'gl-app' } };

    await spawnMergeRecoveryTask(warnings, 'agent-gl', task, 'GitLabApp', '/mock/gl-workspace');

    expect(addTask).toHaveBeenCalledTimes(1);
    const call = addTask.mock.calls[0][0];
    expect(call.description).toContain('MR');
    expect(call.context).toContain('glab mr list --source-branch feature/x');
    expect(call.context).toContain('glab mr create --source-branch feature/x --target-branch main');
    expect(call.context).not.toContain('gh pr ');
  });
});
