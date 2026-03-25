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

vi.mock('uuid', () => ({
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
  acquire: vi.fn(),
  release: vi.fn(),
  hasCapacity: vi.fn(() => true),
  waitForLane: vi.fn()
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
  createPR: vi.fn(),
  generatePRDescription: vi.fn()
}));

vi.mock('./runner.js', () => ({
  executeApiRun: vi.fn(),
  executeCliRun: vi.fn(),
  createRun: vi.fn()
}));

// --- Import the function under test and the mocked dependencies ---

import { cleanupAgentWorktree } from './subAgentSpawner.js';
import { getAgent } from './cos.js';
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
    // generatePRDescription returns a rich body that includes the task description
    git.generatePRDescription.mockImplementation((_dir, _base, _head, desc) =>
      Promise.resolve(`Automated PR created by PortOS Chief of Staff.\n\n## Changes\n- feat: implemented task\n\n**1 file changed** (+10 -2)\n\n<details><summary>Original task</summary>\n\n${desc || 'CoS automated task'}\n\n</details>`)
    );
  });

  it('should run PR flow when openPR is true and success is true', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/1' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true, description: 'Test task' });

    expect(git.push).toHaveBeenCalledWith('/mock/root/data/cos/worktrees/agent-1', 'cos/task-abc123');
    expect(git.createPR).toHaveBeenCalledWith('/mock/root/data/cos/worktrees/agent-1', {
      title: 'Test task',
      body: expect.stringContaining('Test task'),
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

  it('should use default description when none provided', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/6' });

    await cleanupAgentWorktree('agent-1', true, { openPR: true });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: 'CoS automated task',
      body: expect.stringContaining('CoS automated task')
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
});
