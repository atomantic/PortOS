import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock every dependency agentWorktreeCleanup.js pulls in transitively ---

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  // `execFile` is pulled in transitively by codeReview.js → lmStudioManager
  // (via `resolveReviewLoopOptions`'s dependency graph), even though this
  // test never exercises it directly.
  execFile: vi.fn()
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
  getAgent: vi.fn().mockResolvedValue(null),
  getAgentRecord: vi.fn().mockResolvedValue(null)
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
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn().mockResolvedValue({}),
  // instances.js (now pulled in via agentLifecycle's identity stamping, #1563)
  // resolves `dataPath('instances.json')` at module load and writes via
  // atomicWrite — both must be present on the mock or the import graph throws.
  dataPath: vi.fn((p) => `/mock/root/data/${p}`),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
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

vi.mock('./worktreeManager.js', async (importOriginal) => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  cleanupOrphanedWorktrees: vi.fn(),
  // Real: the resume path's "is this dirt real work?" answer must be the SAME
  // classifier removeWorktree preserves a tree on, and it's a pure function.
  classifyWorktreeDirt: (await importOriginal()).classifyWorktreeDirt
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
  suggestPRTitle: vi.fn(),
  deleteBranch: vi.fn().mockResolvedValue(undefined),
  // Default: the branch is 2 commits ahead of the default branch, so
  // resolveResumePointer reports it as resumable. Tests override per case.
  getBranchComparison: vi.fn().mockResolvedValue({ ahead: 2, commits: [], stats: {} }),
  // Read off a SURVIVING worktree when deciding whether a retry can adopt it.
  getBranch: vi.fn().mockResolvedValue(''),
  getStatusPorcelain: vi.fn().mockResolvedValue(''),
  // Default: no branch is claimed by a surviving worktree, so an ahead branch is
  // attachable. The "still checked out" test overrides this.
  getWorktreeBranches: vi.fn().mockResolvedValue(new Set()),
  // Default: NOT already merged, so an ahead branch is resumable. The
  // rebase/squash-merged case overrides this.
  isBranchMergedInto: vi.fn().mockResolvedValue(false),
  requestCopilotReview: vi.fn().mockResolvedValue({ success: true }),
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: process.env, host: 'github.com', owner: null, account: null }),
  parsePullRequestUrl: vi.fn((url) => {
    // Minimal stand-in: extract host/owner/repo/number from GitHub PR URLs
    const match = url?.match?.(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:pull|merge_requests|-\/merge_requests)\/(\d+)/);
    if (!match) return null;
    return { host: match[1], owner: match[2], repo: match[3], number: Number(match[4]) };
  })
}));

const queuePendingMergeMock = vi.fn();
vi.mock('./prWatcher.js', () => ({
  queuePendingMerge: (...args) => queuePendingMergeMock(...args)
}));

// The `if-missing` net's OTHER half: a FAILED run may still have opened its PR
// before it died, and cleanup hands that orphan to the same follow-up machinery.
const findPullRequestForBranchMock = vi.fn().mockResolvedValue({ status: 'unavailable' });
vi.mock('./github.js', () => ({
  findPullRequestForBranch: (...args) => findPullRequestForBranchMock(...args)
}));

// The `if-missing` safety net asks finalize's own PR-claim check whether
// the agent actually opened the PR it was told to open (#3733).
const verifyPrClaimMock = vi.fn();
vi.mock('./agentFinalization.js', () => ({
  PR_MISSING_CATEGORY: 'pr-missing',
  verifyPrClaim: (...args) => verifyPrClaimMock(...args)
}));

vi.mock('./runner.js', () => ({
  executeApiRun: vi.fn(),
  executeCliRun: vi.fn(),
  createRun: vi.fn()
}));

// --- Import the function under test and the mocked dependencies ---

import { join } from 'path';
import { existsSync as existsSyncMock } from 'fs';
// All five come from `agentWorktreeCleanup.js`, the module that defines them.
// They used to be pulled through the `subAgentSpawner.js` barrel, which was
// retired in #3450.
import { cleanupAgentWorktree, spawnMergeRecoveryTask, spawnReviewLoopFollowUp, resolveResumePointer, resolveTaskResumePatch, recordTaskResumePointer, releaseRetryHold, resumePointerMetadata } from './agentWorktreeCleanup.js';
import { getAgent, getAgentRecord, getTaskById, addTask, updateTask } from './cos.js';
import { removeWorktree } from './worktreeManager.js';
import { PATHS } from '../lib/fileUtils.js';
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

describe('cleanupAgentWorktree - PR-creation path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queuePendingMergeMock.mockResolvedValue(false);
    // Default: agent is a worktree agent with valid metadata
    getAgent.mockResolvedValue(mockWorktreeAgent());
    git.getRepoBranches.mockResolvedValue({ baseBranch: 'main', devBranch: null });
    // generatePRDescription returns a rich body from agent output summary
    git.generatePRDescription.mockImplementation(() =>
      Promise.resolve('Automated PR created by PortOS Chief of Staff.\n\n## Summary\n\nImplemented the requested feature with new API endpoints and UI components.')
    );
    // suggestPRTitle echoes the fallback (task description) by default; specific
    // tests can override to simulate a real commit-derived title.
    git.suggestPRTitle.mockImplementation((_dir, _base, _head, fallback) =>
      Promise.resolve((fallback || 'CoS automated task').split(/[\r\n]/)[0].trim().substring(0, 100) || 'CoS automated task')
    );
  });

  it('should run PR flow when prCreation is always and success is true', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/1' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test task' });

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

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

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

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test task' });

    expect(git.push).toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should preserve worktree when createPR returns { success: false }', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: false, error: 'PR already exists' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test task' });

    expect(git.createPR).toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should silently clean up worktree when createPR fails with "No commits between"', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: false, error: 'GraphQL: No commits between main and cos/task-abc123 (createPullRequest)' });

    const warnings = await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test task' });

    expect(git.createPR).toHaveBeenCalled();
    // Agent made no changes — delete remote branch and clean up silently without a warning
    expect(git.deleteBranch).toHaveBeenCalledWith('/mock/workspace', 'cos/task-abc123', { remote: true });
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false });
    expect(warnings).toHaveLength(0);
  });

  it('should use auto-merge path when prCreation is never (success)', async () => {
    await cleanupAgentWorktree('agent-1', true, { prCreation: 'never' });

    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: true, preserveBranchWithCommits: false });
  });

  it('should use auto-merge path when prCreation is not provided (defaults to never)', async () => {
    await cleanupAgentWorktree('agent-1', true);

    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: true, preserveBranchWithCommits: false });
  });

  it('should skip PR flow when prCreation is always but success is false', async () => {
    await cleanupAgentWorktree('agent-1', false, { prCreation: 'always' });

    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
    // Falls through to auto-merge path with merge: false (failure cleanup). A
    // FAILED agent additionally asks removeWorktree to KEEP the branch when it
    // holds commits, so the task's retry can resume from it (#3167).
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false, preserveBranchWithCommits: true });
  });

  it('should use baseBranch as PR base (not devBranch, since worktrees are created from baseBranch)', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/3' });
    git.getRepoBranches.mockResolvedValue({ baseBranch: 'main', devBranch: 'develop' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test' });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      base: 'main'
    }));
  });

  it('should fall back to "main" when getRepoBranches fails', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/4' });
    git.getRepoBranches.mockRejectedValue(new Error('not a git repo'));

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test' });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      base: 'main'
    }));
  });

  it('should preserve worktree when createPR throws', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockRejectedValue(new Error('network error'));

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test' });

    // PR creation failed — worktree preserved for manual intervention
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should truncate long descriptions to 100 chars for PR title', async () => {
    const longDesc = 'A'.repeat(200);
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/5' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: longDesc });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: 'A'.repeat(100)
    }));
  });

  it('should use only first line of multiline description for PR title', async () => {
    const multilineDesc = '[Improvement: grace] Error Handling\n\nAnalyze the codebase:\n\nRepository: /Users/foo/grace';
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/7' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: multilineDesc });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: '[Improvement: grace] Error Handling'
    }));
  });

  it('should use default description when none provided', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/6' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

    expect(git.createPR).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: 'CoS automated task',
      body: expect.stringContaining('Chief of Staff')
    }));
  });

  // --- Early-exit guard tests ---

  it('should no-op when agent is not a worktree agent', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: false } });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should no-op when agent state is null', async () => {
    getAgent.mockResolvedValue(null);

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should no-op for persistent worktree agents', async () => {
    getAgent.mockResolvedValue(mockWorktreeAgent({ isPersistentWorktree: true }));

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('should no-op when sourceWorkspace or worktreeBranch is missing', async () => {
    getAgent.mockResolvedValue(mockWorktreeAgent({ sourceWorkspace: null }));

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

    expect(git.push).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  // --- requestCopilotReview flag tests (regression for the openPR && !reviewLoop bug) ---

  it('should request a Copilot review after PR creation when requestCopilotReview is true', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/7' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', requestCopilotReview: true, description: 'Test' });

    expect(git.requestCopilotReview).toHaveBeenCalledWith('/mock/root/data/cos/worktrees/agent-1', 'https://github.com/test/repo/pull/7');
  });

  it('should NOT request a Copilot review when requestCopilotReview is false', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/8' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', requestCopilotReview: false, description: 'Test' });

    expect(git.requestCopilotReview).not.toHaveBeenCalled();
  });

  it('should still create PR (not auto-merge) when both prCreation:always and requestCopilotReview are set — regression', async () => {
    // Regression for the bug where `openPR: taskOpenPR && !taskReviewLoop` skipped
    // PR creation when both flags were set, causing auto-merge into main with no PR/review.
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/9' });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', requestCopilotReview: true, description: 'Test' });

    expect(git.createPR).toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false });
  });

  // #3733: a slashdo-free harness now opens its own PR, so cleanup's job flips
  // from "create the PR" to "make sure one exists". Getting this wrong in either
  // direction is expensive — a duplicate PR, or a branch nobody ever reviews.
  describe('prCreation: if-missing safety net', () => {
    const netOpts = { prCreation: 'if-missing', description: 'Test task' };

    it('stands down when the agent already opened its own PR', async () => {
      verifyPrClaimMock.mockResolvedValue({ ok: true, branch: 'cos/task-abc123' });
      git.push.mockResolvedValue(undefined);

      await cleanupAgentWorktree('agent-1', true, netOpts);

      expect(git.push).not.toHaveBeenCalled();
      expect(git.createPR).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled();
    });

    it('opens the PR itself when the forge confirms the agent opened none', async () => {
      verifyPrClaimMock.mockResolvedValue({ ok: false, category: 'pr-missing', branch: 'cos/task-abc123' });
      git.push.mockResolvedValue(undefined);
      git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/42' });

      const warnings = await cleanupAgentWorktree('agent-1', true, netOpts);

      expect(git.createPR).toHaveBeenCalled();
      expect(warnings.some(w => w.includes('was told to open its own pull request'))).toBe(true);
    });

    it('stands down on an unreachable forge — a duplicate PR is worse than a flagged one', async () => {
      verifyPrClaimMock.mockResolvedValue({ ok: false, category: 'forge-unreachable', branch: 'cos/task-abc123' });

      const warnings = await cleanupAgentWorktree('agent-1', true, netOpts);

      expect(git.createPR).not.toHaveBeenCalled();
      // …but standing down must NOT also throw the work away. `removeWorktree`
      // deletes an unmerged branch outright on a `success` run, so without this
      // a transient `gh pr list` failure takes the agent's only copy of the
      // commits with it — we chose not to push, so the branch IS the copy.
      expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123',
        expect.objectContaining({ preserveBranchWithCommits: true }));
      expect(warnings.some(w => w.includes('Could not confirm a pull request'))).toBe(true);
    });

    it('lets the branch be tidied up when the agent DID open its PR', async () => {
      verifyPrClaimMock.mockResolvedValue({ ok: true, branch: 'cos/task-abc123' });

      const warnings = await cleanupAgentWorktree('agent-1', true, netOpts);

      expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123',
        expect.objectContaining({ preserveBranchWithCommits: false }));
      expect(warnings).toEqual([]);
    });

    it('treats the no-branch sentinel as uncertain — it is NOT a confirmed PR', async () => {
      // `verifyPrClaim` returns `{ok:true, branch:null}` when it could not name a
      // branch (detached HEAD — e.g. an agent that left an aborted rebase
      // behind). Reading that third `ok:true` shape as "the agent opened its PR"
      // stood cleanup down AND, because the stand-down was not marked uncertain,
      // let `removeWorktree` force-delete a branch that was never pushed and has
      // no PR — losing the commits outright.
      verifyPrClaimMock.mockResolvedValue({ ok: true, branch: null });

      const warnings = await cleanupAgentWorktree('agent-1', true, netOpts);

      expect(git.createPR).not.toHaveBeenCalled();
      expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123',
        expect.objectContaining({ preserveBranchWithCommits: true }));
      expect(warnings.some(w => w.includes('Could not confirm a pull request'))).toBe(true);
    });

    it('treats a thrown verification as uncertain, not as "no PR"', async () => {
      // Failing open here would open a duplicate PR on every transient error.
      verifyPrClaimMock.mockRejectedValue(new Error('boom'));

      await cleanupAgentWorktree('agent-1', true, netOpts);

      expect(git.createPR).not.toHaveBeenCalled();
      expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123',
        expect.objectContaining({ preserveBranchWithCommits: true }));
    });

    it('stands down when the branch holds no commits — there was nothing to open a PR for', async () => {
      verifyPrClaimMock.mockResolvedValue({ ok: true, noChangesToShip: true, branch: 'cos/task-abc123' });

      await cleanupAgentWorktree('agent-1', true, netOpts);

      expect(git.createPR).not.toHaveBeenCalled();
    });

    // The failed-run half of the net hands its orphaned PR to the same follow-up,
    // so it needs the same ordering guarantee as the success path: the follow-up
    // checks the branch out, and the teardown below has to release it first.
    it('releases the branch before handing a failed run’s orphaned PR to a follow-up', async () => {
      findPullRequestForBranchMock.mockResolvedValue({ status: 'found', url: 'https://github.com/test/repo/pull/77' });
      addTask.mockResolvedValue({ id: 'sys-rl-orphan' });

      const warnings = await cleanupAgentWorktree('agent-1', false, netOpts);

      expect(addTask).toHaveBeenCalledTimes(1);
      expect(addTask.mock.calls[0][0].metadata.reviewLoopPRUrl).toBe('https://github.com/test/repo/pull/77');
      expect(removeWorktree).toHaveBeenCalledTimes(1);
      expect(removeWorktree.mock.invocationCallOrder[0])
        .toBeLessThan(addTask.mock.invocationCallOrder[0]);
      expect(warnings.some(w => w.includes('a follow-up was queued to land it'))).toBe(true);
    });

    it('still creates the PR outright when the net is off (a lean session hands off)', async () => {
      git.push.mockResolvedValue(undefined);
      git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/43' });

      await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', description: 'Test task' });

      expect(verifyPrClaimMock).not.toHaveBeenCalled();
      expect(git.createPR).toHaveBeenCalled();
    });
  });

  it('should record warning but still complete cleanup when Copilot review request fails', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/10' });
    git.requestCopilotReview.mockResolvedValue({ success: false, error: 'gh exited with code 1' });

    const warnings = await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', requestCopilotReview: true, description: 'Test' });

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

    const warnings = await cleanupAgentWorktree('agent-1', true, { prCreation: 'always', requestCopilotReview: true, description: 'Test' });

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
      prCreation: 'always',
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

  // Git allows a branch in exactly one worktree. The follow-up attaches its own
  // worktree to the PR branch and the CoS tick preps it a second or two after
  // this call queues it — so tearing THIS worktree down afterwards lost the race:
  // `git worktree add` failed with "is already used by worktree at …", the
  // follow-up was blocked, and the PR it existed to land was orphaned.
  it('removes the worktree BEFORE queueing the follow-up that must check out its branch', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/44' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-order' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(removeWorktree.mock.invocationCallOrder[0])
      .toBeLessThan(addTask.mock.invocationCallOrder[0]);
    // ...but not so early that the Copilot pre-request loses the checkout it runs in.
    expect(git.requestCopilotReview.mock.invocationCallOrder[0])
      .toBeLessThan(removeWorktree.mock.invocationCallOrder[0]);
  });

  it('STILL spawns the review-loop follow-up when the Copilot pre-request fails (follow-up re-requests at its turn)', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/43' });
    git.requestCopilotReview.mockResolvedValue({ success: false, error: 'gh exited 1' });
    addTask.mockResolvedValue({ id: 'sys-rl-q' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    // A failed pre-request is recoverable — the follow-up requests Copilot itself at
    // its turn. Not spawning would leave the PR open with no review loop (the bug).
    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewers).toEqual(['copilot']);
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('inherits the source task provider/model pins so the follow-up can actually run', async () => {
    // A follow-up needs a coding harness. On an install whose ACTIVE provider is
    // api-only, an unpinned follow-up is permanently rejected and the PR it was
    // spawned to land never merges.
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/99' });
    addTask.mockResolvedValue({ id: 'sys-rl-p' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: false, description: 'X',
      originalTask: {
        id: 'task-orig',
        metadata: { provider: 'claude-code', providerId: 'claude-code', model: 'claude-opus-5', effort: 'high' },
        description: 'X'
      }
    });

    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.provider).toBe('claude-code');
    expect(followUp.metadata.providerId).toBe('claude-code');
    expect(followUp.metadata.model).toBe('claude-opus-5');
    expect(followUp.metadata.effort).toBe('high');
  });

  it('does not inherit a model pin without its provider', async () => {
    // A bare model would be honored against whatever provider resolution later
    // picks — handing e.g. a Claude model id to Codex and failing the run.
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/100' });
    addTask.mockResolvedValue({ id: 'sys-rl-q' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: false, description: 'X',
      originalTask: { id: 'task-orig', metadata: { model: 'claude-opus-5', effort: 'high' }, description: 'X' }
    });

    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.model).toBeUndefined();
    expect(followUp.metadata.provider).toBeUndefined();
    // Effort is provider-agnostic, so it still travels.
    expect(followUp.metadata.effort).toBe('high');
  });

  it('leaves a jira-sprint-manager PR open — no follow-up merges behind the board', async () => {
    // That task type transitions its ticket to "In Review" and hands the PR to a
    // human; merging here would land the work while JIRA still shows it in review,
    // and nothing in this path knows the ticket key to move it to Done.
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/77' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: false, description: 'X',
      originalTask: { id: 'task-orig', metadata: { analysisType: 'jira-sprint-manager' }, description: 'X' }
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('leaves a JIRA-ticketed task PR open regardless of task type', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/78' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: false, description: 'X',
      originalTask: { id: 'task-orig', metadata: { jiraTicketId: 'PROJ-1' }, description: 'X' }
    });

    expect(addTask).not.toHaveBeenCalled();
  });

  it('leaves an explicitly leave-open PR without spawning a follow-up', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/79' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always',
      prCompletion: 'leave-open',
      reviewers: ['copilot'],
      description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    expect(git.requestCopilotReview).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('spawns a merge-only follow-up on non-GitHub forges when copilot was the only reviewer', async () => {
    // Copilot can't review a GitLab MR, so the review loop has nothing to run — but
    // the MR still has to land, so the follow-up degrades to merge-only rather than
    // not spawning (which left the MR open with no owner).
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://gitlab.com/group/proj/-/merge_requests/12' });
    git.requestCopilotReview.mockResolvedValue({ success: true, skipped: true });
    addTask.mockResolvedValue({ id: 'sys-rl-gl' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask.mock.calls[0][0].metadata.reviewLoopMergeOnly).toBe(true);
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('spawns a MERGE-ONLY follow-up (no reviewers) when requestCopilotReview is false', async () => {
    // Review Loop off: PortOS opened this PR and nothing else would ever merge it,
    // so the follow-up runs in merge-only mode — CI gate, then merge.
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/44' });
    addTask.mockResolvedValue({ id: 'sys-rl-m' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: false, description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    expect(git.requestCopilotReview).not.toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopMergeOnly).toBe(true);
    // Unpinned source task → no provider pins to inherit.
    expect(followUp.metadata.provider).toBeUndefined();
    // No reviewer may be defaulted back in — this PR was never meant to be reviewed.
    expect(followUp.metadata.reviewLoopReviewers).toEqual([]);
    expect(followUp.metadata.reviewLoopReviewerUsernames).toEqual([]);
    expect(followUp.description).toMatch(/^\[Merge\]/);
    // Still attaches to the PR branch so it can fix a failing check before merging.
    expect(followUp.metadata.existingBranch).toBe('cos/task-abc123');
    expect(removeWorktree).toHaveBeenCalled();
  });

  it('queues a managed GitHub merge-only PR for the watcher instead of consuming an agent lane', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/61', cli: 'gh' });
    queuePendingMergeMock.mockResolvedValue(true);

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always',
      requestCopilotReview: false,
      description: 'Build with deterministic merge',
      originalTask: {
        id: 'task-orig',
        priority: 'HIGH',
        metadata: { app: 'managed-app', provider: 'codex', providerId: 'codex', model: 'gpt-5.6', effort: 'high' },
        description: 'Build with deterministic merge'
      }
    });

    expect(queuePendingMergeMock).toHaveBeenCalledWith('managed-app', expect.objectContaining({
      prNumber: 61,
      prBranch: 'cos/task-abc123',
      sourceAgentId: 'agent-1',
      sourceTask: expect.objectContaining({ id: 'task-orig', priority: 'HIGH' })
    }));
    expect(addTask).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false });
  });

  // --- non-Copilot reviewer (--review-with claude/antigravity/codex) ---

  it('should NOT call the native GH Copilot reviewer API when the list has no copilot', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/55' });
    addTask.mockResolvedValue({ id: 'sys-rl-y' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['claude'], description: 'X',
      originalTask: { id: 'task-orig', metadata: {}, description: 'X' }
    });

    expect(git.requestCopilotReview).not.toHaveBeenCalled();
  });

  it('should still spawn the review-loop follow-up when a non-Copilot reviewer is selected', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/56' });
    addTask.mockResolvedValue({ id: 'sys-rl-z' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['codex'], description: 'Build with codex review',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewers).toEqual(['codex']);
    expect(followUp.metadata.reviewLoopFollowUp).toBe(true);
  });

  it('pre-requests Copilot only when it LEADS the list, and threads stop-mode/applies through', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/57' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-w' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot', 'codex', 'antigravity'],
      reviewStopMode: 'on-findings', reviewerApplies: true,
      reviewerModels: { codex: 'gpt-5.6-sol', claude: 'qwen2.5:7b' }, description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    expect(git.requestCopilotReview).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewers).toEqual(['copilot', 'codex', 'antigravity']);
    expect(followUp.metadata.reviewLoopStopMode).toBe('on-findings');
    expect(followUp.metadata.reviewLoopReviewerApplies).toBe(true);
    // Only the codex entry rides along — codex is in the list, claude is not, so
    // the map is narrowed to the reviewers actually running.
    expect(followUp.metadata.reviewLoopReviewerModels).toEqual({ codex: 'gpt-5.6-sol' });
    // Back-compat mirror of the codex entry for an older prompt builder.
    expect(followUp.metadata.reviewLoopCodexModel).toBe('gpt-5.6-sol');
  });

  it('threads per-reviewer ~max round caps into the follow-up metadata', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/61' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-max' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot', 'ollama'],
      // `nope` is not a reviewer and `codex: -1` is not a cap — both dropped.
      // An explicit 0 (loop until clean) survives.
      reviewerMaxRounds: { ollama: 1, copilot: 0, nope: 2, codex: -1 },
      description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewerMaxRounds).toEqual({ ollama: 1, copilot: 0 });
  });

  it('drops the ~max caps when the run has no review loop', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/62' });
    addTask.mockResolvedValue({ id: 'sys-rl-nomax' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', prCompletion: 'merge-on-green', reviewers: ['copilot', 'ollama'],
      reviewerMaxRounds: { ollama: 1 }, description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewerMaxRounds).toEqual({});
  });

  it('threads the claude model when claude is among the reviewers (Ollama-backed reviewer)', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/60' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-cl' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot', 'claude'],
      reviewerModels: { codex: 'gpt-5.6-sol', claude: 'qwen2.5:7b' }, description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    const [followUp] = addTask.mock.calls[0];
    // claude is in the list, codex is not — map narrows to claude only.
    expect(followUp.metadata.reviewLoopReviewerModels).toEqual({ claude: 'qwen2.5:7b' });
    // No codex reviewer → no legacy codex mirror.
    expect(followUp.metadata.reviewLoopCodexModel).toBeNull();
  });

  // The two maps narrow against SEPARATE rosters (EFFORT_SELECTABLE_REVIEWERS vs
  // MODEL_SELECTABLE_REVIEWERS), and their memberships genuinely differ: `grok`
  // takes `--model` but has no effort flag (#3729), the mirror of `antigravity`,
  // which took an effort but no model until #3728. So this pins that each map is
  // narrowed independently: an effort pin on a reviewer with no model pin (and
  // vice versa) must survive this hop intact, and a pin on the roster the reviewer
  // is absent from is dropped.
  it('narrows each pin map on its own roster', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/61' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-eff' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot', 'antigravity', 'claude', 'grok'],
      reviewerModels: { claude: 'qwen2.5:7b', grok: 'grok-code-fast-1' },
      // `codex` isn't in the reviewer list; `copilot` has no effort control at all,
      // and neither does `grok` — its CLI takes no effort flag.
      reviewerEfforts: { antigravity: 'high', claude: 'xhigh', codex: 'low', copilot: 'high', grok: 'high' },
      description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    const [followUp] = addTask.mock.calls[0];
    // `grok` is a listed reviewer but takes no effort, so its effort pin is dropped…
    expect(followUp.metadata.reviewLoopReviewerEfforts).toEqual({ antigravity: 'high', claude: 'xhigh' });
    // …while its MODEL pin survives: the model map narrows on its own roster and is
    // unaffected by the effort pins.
    expect(followUp.metadata.reviewLoopReviewerModels).toEqual({ claude: 'qwen2.5:7b', grok: 'grok-code-fast-1' });
  });

  it('drops the effort map entirely when no effort-capable reviewer is in the list', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/62' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-noeff' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot'],
      reviewerEfforts: { claude: 'high' }, description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    // Empty → null, so the prompt builder's "nothing configured" path is unambiguous.
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewerEfforts).toBeNull();
  });
  it('drops the model map entirely when no model-capable reviewer is in the list', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/59' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-nc' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot', 'antigravity'],
      reviewerModels: { codex: 'gpt-5.6-sol', claude: 'qwen2.5:7b' }, description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewerModels).toBeNull();
    expect(followUp.metadata.reviewLoopCodexModel).toBeNull();
  });

  it('does NOT pre-request Copilot when it trails a CLI reviewer, but keeps it in the follow-up list', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/58' });
    addTask.mockResolvedValue({ id: 'sys-rl-v' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['codex', 'antigravity', 'copilot'], description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    // Copilot is not first → no stale pre-request; the follow-up requests it at its turn.
    expect(git.requestCopilotReview).not.toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewers).toEqual(['codex', 'antigravity', 'copilot']);
  });

  // --- arbitrary GitHub reviewer usernames (gate-merge) ---

  it('stamps reviewLoopReviewerUsernames onto the follow-up (normalized, @-stripped)', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/60' });
    git.requestCopilotReview.mockResolvedValue({ success: true });
    addTask.mockResolvedValue({ id: 'sys-rl-u' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot'],
      usernames: ['@CodeReviewbot', 'bad token', 'codereviewbot'], description: 'Build',
      originalTask: { id: 'task-orig', priority: 'MEDIUM', metadata: { app: 'sparsetree' }, description: 'Build' }
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewers).toEqual(['copilot']);
    expect(followUp.metadata.reviewLoopReviewerUsernames).toEqual(['CodeReviewbot']);
  });

  it('spawns a username-only follow-up on a non-GitHub forge (copilot stripped, username drives the loop)', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://gitlab.com/group/proj/-/merge_requests/13' });
    git.requestCopilotReview.mockResolvedValue({ success: true, skipped: true });
    addTask.mockResolvedValue({ id: 'sys-rl-uonly' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always', requestCopilotReview: true, reviewers: ['copilot'],
      usernames: ['CodeReviewbot'], description: 'Build',
      originalTask: { id: 'task-orig', metadata: {}, description: 'Build' }
    });

    // Copilot is GitHub-only and stripped on GitLab, but the username reviewer is
    // forge-agnostic and keeps the follow-up alive with an empty keyed list.
    expect(addTask).toHaveBeenCalledTimes(1);
    const [followUp] = addTask.mock.calls[0];
    expect(followUp.metadata.reviewLoopReviewers).toEqual([]);
    expect(followUp.metadata.reviewLoopReviewerUsernames).toEqual(['CodeReviewbot']);
  });

  // --- skipMerge tests for review-loop follow-up cleanup ---

  it('should pass merge: false in the auto-merge fallback when skipMerge is true (review-loop follow-up cleanup)', async () => {
    // The follow-up agent already merged via `gh pr merge`; re-merging the worktree
    // branch into source workspace would duplicate the squashed commits.
    await cleanupAgentWorktree('agent-1', true, { prCreation: 'never', skipMerge: true });

    expect(removeWorktree).toHaveBeenCalledWith(
      'agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false, preserveBranchWithCommits: false }
    );
  });

  it('should still pass merge: true in the auto-merge fallback when skipMerge is false on success', async () => {
    await cleanupAgentWorktree('agent-1', true, { prCreation: 'never', skipMerge: false });

    expect(removeWorktree).toHaveBeenCalledWith(
      'agent-1', '/mock/workspace', 'cos/task-abc123', { merge: true, preserveBranchWithCommits: false }
    );
  });

  // --- branch preservation for resume (#3167) ---

  it('asks removeWorktree to preserve a FAILED agent\'s branch so its retry can resume', async () => {
    await cleanupAgentWorktree('agent-1', false);

    expect(removeWorktree).toHaveBeenCalledWith(
      'agent-1', '/mock/workspace', 'cos/task-abc123',
      expect.objectContaining({ preserveBranchWithCommits: true })
    );
  });

  it('does NOT preserve the branch on success — the merge/PR path owns cleanup', async () => {
    await cleanupAgentWorktree('agent-1', true);

    expect(removeWorktree).toHaveBeenCalledWith(
      'agent-1', '/mock/workspace', 'cos/task-abc123',
      expect.objectContaining({ preserveBranchWithCommits: false })
    );
  });
});

const DEAD_BRANCH = 'cos/task-1/agent-x';
const DEAD_TREE = join(PATHS.worktrees, 'agent-x');

describe('resolveResumePointer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    git.getDefaultBranch.mockResolvedValue('main');
    git.getWorktreeBranches.mockResolvedValue(new Set());
    git.isBranchMergedInto.mockResolvedValue(false);
    existsSyncMock.mockReturnValue(false);
  });

  // The incident shape: PortOS merges with `--rebase` by default, so a landed
  // branch has NEW SHAs and still reads as "ahead" of the default branch. Pointing
  // a retry at it would have it build on already-merged work.
  it('returns null for a rebase/squash-merged branch even though it reads as ahead', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    git.getBranchComparison.mockResolvedValue({ ahead: 6, commits: [], stats: {} });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH)).resolves.toBeNull();
  });

  it('fails OPEN (no resume) when the merged check errors', async () => {
    git.isBranchMergedInto.mockRejectedValue(new Error('git exploded'));

    await expect(resolveResumePointer('/repo', DEAD_BRANCH)).resolves.toBeNull();
  });

  it('returns null when the branch is still checked out in a worktree that is not the dead agent’s', async () => {
    // A dirty tree makes removeWorktree preserve the WORKTREE too, so the branch
    // stays claimed. `git worktree add` would fail "already checked out", which is
    // worse for the retry than starting clean.
    git.getWorktreeBranches.mockResolvedValue(new Set([DEAD_BRANCH]));
    git.getBranchComparison.mockResolvedValue({ ahead: 5, commits: [], stats: {} });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toBeNull();
  });

  it('still resumes when a DIFFERENT branch is checked out elsewhere', async () => {
    git.getWorktreeBranches.mockResolvedValue(new Set(['main', 'cos/task-9/agent-z']));
    git.getBranchComparison.mockResolvedValue({ ahead: 2, commits: [], stats: {} });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH)).resolves.toEqual({
      branchName: DEAD_BRANCH, worktreePath: null
    });
  });

  it('returns the branch when it holds commits the default branch does not', async () => {
    git.getBranchComparison.mockResolvedValue({ ahead: 3, commits: [], stats: {} });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH)).resolves.toEqual({
      branchName: DEAD_BRANCH, worktreePath: null
    });
    expect(git.getBranchComparison).toHaveBeenCalledWith('/repo', 'main', DEAD_BRANCH);
  });

  it('returns null when the branch holds nothing to resume', async () => {
    git.getBranchComparison.mockResolvedValue({ ahead: 0, commits: [], stats: {} });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH)).resolves.toBeNull();
  });

  it('returns null for an absent branch (empty comparison), not a phantom resume', async () => {
    // An absent branch makes the rev-range invalid, so getBranchComparison comes
    // back with ahead: 0 rather than throwing.
    git.getBranchComparison.mockResolvedValue({ ahead: 0, commits: [], stats: {} });

    await expect(resolveResumePointer('/repo', 'cos/gone')).resolves.toBeNull();
  });

  it('returns null when git errors — never claims a resume it cannot substantiate', async () => {
    git.getBranchComparison.mockRejectedValue(new Error('not a git repository'));

    await expect(resolveResumePointer('/repo', DEAD_BRANCH)).resolves.toBeNull();
  });

  it('returns null without touching git when the workspace or branch is missing', async () => {
    await expect(resolveResumePointer(null, DEAD_BRANCH)).resolves.toBeNull();
    await expect(resolveResumePointer('/repo', null)).resolves.toBeNull();
    expect(git.getBranchComparison).not.toHaveBeenCalled();
  });

  it('falls back to main when the default branch cannot be detected', async () => {
    git.getDefaultBranch.mockRejectedValue(new Error('no remote'));
    git.getBranchComparison.mockResolvedValue({ ahead: 1, commits: [], stats: {} });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH)).resolves.toEqual({
      branchName: DEAD_BRANCH, worktreePath: null
    });
    expect(git.getBranchComparison).toHaveBeenCalledWith('/repo', 'main', DEAD_BRANCH);
  });

  // --- Worktree adoption (the server-restart shape) ---

  // Each adoption case varies exactly one of these; the rest is the shape of "a
  // worktree survived on this branch".
  function scriptSurvivingTree({ merged = false, ahead = 0, branch = DEAD_BRANCH, porcelain = ' M a.js\n' } = {}) {
    existsSyncMock.mockReturnValue(true);
    git.isBranchMergedInto.mockResolvedValue(merged);
    git.getBranchComparison.mockResolvedValue({ ahead, commits: [], stats: {} });
    git.getBranch.mockResolvedValue(branch);
    git.getStatusPorcelain.mockResolvedValue(porcelain);
  }

  // The restart case: the run is killed mid-edit, so it has ZERO commits (the
  // branch reads as merged) and everything it did is uncommitted. Discarding that
  // tree is exactly the "redo the work" bug — adopt it instead.
  it('adopts the dead agent’s surviving worktree when it holds uncommitted work, even with no commits', async () => {
    scriptSurvivingTree({ merged: true, ahead: 0 });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toEqual({
      branchName: DEAD_BRANCH, worktreePath: DEAD_TREE
    });
  });

  it('adopts a surviving worktree whose branch holds unmerged commits even when the tree is clean', async () => {
    scriptSurvivingTree({ merged: false, ahead: 2, porcelain: '' });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toEqual({
      branchName: DEAD_BRANCH, worktreePath: DEAD_TREE
    });
  });

  // The landed-work guard has to survive the adopt path too, or a run reaped just
  // after its PR merged would hand its replacement the merged tree to build on.
  it('does NOT adopt when the branch’s commits already landed', async () => {
    scriptSurvivingTree({ merged: true, ahead: 4 });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toBeNull();
  });

  it('does NOT adopt a directory that has been repurposed onto another branch', async () => {
    scriptSurvivingTree({ ahead: 3, branch: 'some/other-branch' });
    git.getWorktreeBranches.mockResolvedValue(new Set());

    // Falls through to the branch-attach shape rather than handing over the tree.
    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toEqual({
      branchName: DEAD_BRANCH, worktreePath: null
    });
  });

  it('returns null for a clean surviving worktree with nothing to contribute', async () => {
    scriptSurvivingTree({ merged: true, ahead: 0, porcelain: '' });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toBeNull();
  });

  // Same classifier removeWorktree uses to decide a tree is safe to delete — the
  // two must agree, or a tree it would have discarded reads as resumable work.
  it('treats lockfile-only churn as nothing to resume', async () => {
    scriptSurvivingTree({ merged: true, ahead: 0, porcelain: ' M package-lock.json\n' });

    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toBeNull();
  });

  // The ordinary shape — run finished, branch landed, tree already reaped — must
  // not pay for the branch comparison (two git subprocesses, one a whole-branch diff).
  it('bails before the branch comparison when nothing survived and the branch is merged', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);

    await expect(resolveResumePointer('/repo', DEAD_BRANCH, DEAD_TREE)).resolves.toBeNull();
    expect(git.getBranchComparison).not.toHaveBeenCalled();
  });
});

describe('resolveTaskResumePatch / recordTaskResumePointer', () => {
  const agentMetadata = {
    isWorktree: true, sourceWorkspace: '/repo',
    worktreeBranch: DEAD_BRANCH, workspacePath: DEAD_TREE
  };

  beforeEach(() => {
    vi.clearAllMocks();
    git.getDefaultBranch.mockResolvedValue('main');
    git.getWorktreeBranches.mockResolvedValue(new Set());
    git.isBranchMergedInto.mockResolvedValue(false);
    git.getBranchComparison.mockResolvedValue({ ahead: 2, commits: [], stats: {} });
    existsSyncMock.mockReturnValue(false);
  });

  it('stamps the branch, the prior agent, and a null worktree path for a branch-only resume', async () => {
    const task = { id: 'task-1', taskType: 'user', metadata: {} };

    await recordTaskResumePointer({ task, agentId: 'agent-x', agentMetadata });

    expect(updateTask).toHaveBeenCalledWith('task-1', {
      metadata: {
        existingBranch: DEAD_BRANCH,
        resumedFromAgentId: 'agent-x',
        resumeWorktreePath: null
      }
    }, 'user');
  });

  it('stamps the worktree path when the dead agent’s tree survived', async () => {
    existsSyncMock.mockReturnValue(true);
    git.getBranch.mockResolvedValue(DEAD_BRANCH);
    git.getStatusPorcelain.mockResolvedValue(' M a.js\n');
    const task = { id: 'task-1', taskType: 'user', metadata: {} };

    await recordTaskResumePointer({ task, agentId: 'agent-x', agentMetadata });

    expect(updateTask).toHaveBeenCalledWith('task-1', {
      metadata: expect.objectContaining({ resumeWorktreePath: DEAD_TREE })
    }, 'user');
  });

  // The agent's own recorded path wins over the <worktrees>/<agentId> convention,
  // so an app-repo agent whose tree lives elsewhere is still found.
  it('looks for the tree at the path the agent recorded', async () => {
    existsSyncMock.mockReturnValue(true);
    git.getBranch.mockResolvedValue(DEAD_BRANCH);
    git.getStatusPorcelain.mockResolvedValue(' M a.js\n');

    await recordTaskResumePointer({
      task: { id: 'task-1', metadata: {} }, agentId: 'agent-x',
      agentMetadata: { ...agentMetadata, workspacePath: '/elsewhere/tree' }
    });

    expect(git.getBranch).toHaveBeenCalledWith('/elsewhere/tree');
  });

  it('records nothing when there is no leftover work', async () => {
    git.getBranchComparison.mockResolvedValue({ ahead: 0, commits: [], stats: {} });

    await recordTaskResumePointer({ task: { id: 'task-1', metadata: {} }, agentId: 'agent-x', agentMetadata });

    expect(updateTask).not.toHaveBeenCalled();
  });

  // Attempt 1 left a resumable branch; attempt 2 landed it and then died. Leaving
  // the spent pointer would attach attempt 3 to the merged branch.
  it('CLEARS a spent pointer when a resuming task has nothing left to resume', async () => {
    git.getBranchComparison.mockResolvedValue({ ahead: 0, commits: [], stats: {} });
    const task = { id: 'task-1', taskType: 'user', metadata: { resumedFromAgentId: 'agent-w', existingBranch: 'cos/old' } };

    await recordTaskResumePointer({ task, agentId: 'agent-x', agentMetadata });

    expect(updateTask).toHaveBeenCalledWith('task-1', {
      metadata: { existingBranch: undefined, resumedFromAgentId: undefined, resumeWorktreePath: undefined }
    }, 'user');
  });

  // ...but a run that was never EVALUATED must not clear it. A resuming task whose
  // retry couldn't get a worktree (agentWorkspacePrep's degrade path) still has its
  // predecessor's tree sitting on disk for the attempt after this one.
  it('leaves the pointer alone when the run had no worktree to evaluate', async () => {
    const task = { id: 'task-1', taskType: 'user', metadata: { resumedFromAgentId: 'agent-w', existingBranch: 'cos/old' } };

    await recordTaskResumePointer({ task, agentId: 'agent-x', agentMetadata: { isWorktree: false } });

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('skips agents that never had a worktree, and persistent feature-agent worktrees', async () => {
    const task = { id: 'task-1', metadata: {} };

    await recordTaskResumePointer({ task, agentId: 'agent-x', agentMetadata: { isWorktree: false } });
    await recordTaskResumePointer({ task, agentId: 'agent-x', agentMetadata: { ...agentMetadata, isPersistentWorktree: true } });

    expect(updateTask).not.toHaveBeenCalled();
  });

  // Reasoning agents run in a worktree whose edits are deliberately thrown away —
  // resuming one would resurrect code the discard guarantee exists to drop.
  it('skips throwaway (discardWorktree) tasks', async () => {
    const task = { id: 'task-1', metadata: { discardWorktree: true } };

    await recordTaskResumePointer({ task, agentId: 'agent-x', agentMetadata });

    expect(updateTask).not.toHaveBeenCalled();
  });
});

// The shared post-cleanup gate every spawn mode calls (#3368, #3373). Direct-CLI
// and TUI runs used to skip this entirely, so a failed run's preserved branch was
// never pointed at and its retry redid the work from scratch. It now also RELEASES
// the retry hold the failure verdict armed, so the task becomes spawnable and
// pointed in one write.
describe('releaseRetryHold', () => {
  const agentMetadata = {
    isWorktree: true, sourceWorkspace: '/repo',
    worktreeBranch: DEAD_BRANCH, workspacePath: DEAD_TREE
  };
  const task = () => ({ id: 'task-1', taskType: 'user', metadata: {} });

  beforeEach(() => {
    vi.clearAllMocks();
    git.getDefaultBranch.mockResolvedValue('main');
    git.getWorktreeBranches.mockResolvedValue(new Set());
    git.isBranchMergedInto.mockResolvedValue(false);
    git.getBranchComparison.mockResolvedValue({ ahead: 2, commits: [], stats: {} });
    existsSyncMock.mockReturnValue(false);
    getTaskById.mockResolvedValue({ id: 'task-1', status: 'pending' });
    getAgentRecord.mockResolvedValue({ metadata: agentMetadata });
  });

  // The direct-CLI / TUI shape: neither spawn path holds the agent record, so the
  // helper has to read it for the worktree fields — via the transcript-free
  // `getAgentRecord`, since a long TUI run's output.txt is megabytes.
  it('records the pointer for a failed run whose task is still pending', async () => {
    await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false });

    expect(getAgentRecord).toHaveBeenCalledWith('agent-x');
    expect(getAgent).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      metadata: { existingBranch: DEAD_BRANCH, resumedFromAgentId: 'agent-x', resumeWorktreePath: null }
    }, 'user');
  });

  // A task that exhausted its retry budget is waiting on a human — a pointer there
  // is dead metadata `updateTask` has to strip again on the next terminal write.
  it('records nothing when the task is already blocked', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', status: 'blocked' });

    await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false });

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('records nothing on a successful run', async () => {
    await releaseRetryHold({ agentId: 'agent-x', task: task(), success: true });

    expect(getTaskById).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  // "I couldn't read the status" is not "the status is pending" — guessing would
  // stamp a pointer on a blocked task, which a later reviveBlockedTask would then
  // resurrect as a live pointer to a branch nobody vetted.
  it('records nothing when the task status is unreadable', async () => {
    getTaskById.mockRejectedValue(new Error('read failed'));

    await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false });

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('records nothing when the task was deleted mid-run', async () => {
    getTaskById.mockResolvedValue(null);

    await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false });

    expect(updateTask).not.toHaveBeenCalled();
  });

  // Records written before the status field existed read as pending.
  it('treats a status-less legacy task record as pending', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1' });

    await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false });

    expect(updateTask).toHaveBeenCalled();
  });

  // The runner path already holds the agent record; passing it spares a re-read.
  it('uses caller-supplied agent metadata instead of re-reading the record', async () => {
    await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

    expect(getAgentRecord).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalled();
  });

  it('is a no-op without an agent id or a task id', async () => {
    await releaseRetryHold({ agentId: '', task: task(), success: false });
    await releaseRetryHold({ agentId: 'agent-x', task: { metadata: {} }, success: false });

    expect(getTaskById).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  // The #3373 shape. The failure verdict left the task `in_progress` + held; the
  // flip to `pending` and the pointer MUST be the same write, or a dequeue between
  // them claims the retry with no pointer and restarts from scratch.
  describe('a held task (#3373)', () => {
    const heldTask = { id: 'task-1', status: 'in_progress', metadata: { retryPendingCleanup: 'agent-x', retryPendingSince: new Date().toISOString() } };

    it('flips to pending WITH the pointer and the cleared marker in one updateTask', async () => {
      getTaskById.mockResolvedValue(heldTask);

      await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        status: 'pending',
        metadata: {
          existingBranch: DEAD_BRANCH,
          resumedFromAgentId: 'agent-x',
          resumeWorktreePath: null,
          retryPendingCleanup: undefined,
          retryPendingSince: undefined,
        }
      }, 'user');
    });

    // Nothing survived cleanup — the task still has to become spawnable, it just
    // starts clean. Releasing the hold is NOT conditional on having a pointer.
    it('still releases the hold when there is nothing left to resume', async () => {
      getTaskById.mockResolvedValue(heldTask);
      git.getBranchComparison.mockResolvedValue({ ahead: 0, commits: [], stats: {} });

      await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

      expect(updateTask).toHaveBeenCalledWith('task-1', {
        status: 'pending',
        metadata: { retryPendingCleanup: undefined, retryPendingSince: undefined }
      }, 'user');
    });

    // A hold armed before the marker carried an id (legacy shape) is releasable by
    // whoever finds it, and the markdown round-trip stores booleans as strings.
    it('recognizes an unattributed hold after a markdown round-trip', async () => {
      getTaskById.mockResolvedValue({ ...heldTask, metadata: { retryPendingCleanup: 'true' } });

      await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

      expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
    });

    // The whole point of stamping the owner: attempt A's slow cleanup lands after
    // attempt B failed and armed ITS hold. Releasing here would make the task
    // spawnable while B's cleanup is still resolving B's pointer.
    it('does not release a hold armed by a later attempt', async () => {
      getTaskById.mockResolvedValue({ ...heldTask, metadata: { retryPendingCleanup: 'agent-later' } });

      await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

      expect(updateTask).not.toHaveBeenCalled();
    });

    // The orphan sweep got there first and already requeued + cleared the hold, or
    // the retry has since spawned. Either way this run no longer owns the task.
    it('writes nothing when the hold is gone and the task is in_progress again', async () => {
      getTaskById.mockResolvedValue({ id: 'task-1', status: 'in_progress', metadata: {} });

      await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

      expect(updateTask).not.toHaveBeenCalled();
    });

    // A late release must never REOPEN a task that has since gone terminal —
    // user-terminated, budget-exhausted, or completed by a recovery path.
    it('never flips a blocked or completed task, even one carrying a stale marker', async () => {
      getTaskById.mockResolvedValue({ id: 'task-1', status: 'blocked', metadata: { retryPendingCleanup: 'agent-x' } });
      await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

      getTaskById.mockResolvedValue({ id: 'task-1', status: 'completed', metadata: { retryPendingCleanup: 'agent-x' } });
      await releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata });

      expect(updateTask).not.toHaveBeenCalled();
    });

    // The hold stays on disk, so the orphan sweep can finish the transition.
    it('leaves the task held when the release write fails', async () => {
      getTaskById.mockResolvedValue(heldTask);
      updateTask.mockResolvedValueOnce({ error: 'Task file not found' });

      await expect(releaseRetryHold({ agentId: 'agent-x', task: task(), success: false, agentMetadata }))
        .resolves.toEqual({});
    });
  });
});

describe('resumePointerMetadata', () => {
  it('sets the three keys a retry needs to resume', () => {
    expect(resumePointerMetadata({ branchName: 'cos/b', worktreePath: '/t' }, 'agent-x', { metadata: {} })).toEqual({
      existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/t'
    });
  });

  // Attempt 1 left a resumable branch; attempt 2 landed it. Leaving the stale
  // pointer would attach attempt 3 to already-merged work.
  it('clears a pointer this mechanism wrote once there is nothing left to resume', () => {
    expect(resumePointerMetadata(null, 'agent-y', { metadata: { resumedFromAgentId: 'agent-x' } })).toEqual({
      existingBranch: undefined, resumedFromAgentId: undefined, resumeWorktreePath: undefined
    });
  });

  // The review-loop follow-up sets existingBranch itself and has no resumedFrom
  // marker — clearing it would strand the follow-up off its own PR branch.
  it('leaves a foreign existingBranch alone', () => {
    expect(resumePointerMetadata(null, 'agent-y', { metadata: { existingBranch: 'cos/pr-branch' } })).toEqual({});
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

  it('falls back to a merge-only follow-up for GitLab MRs when copilot was the only reviewer', async () => {
    // Copilot is GitHub-only, so nothing survives reviewer resolution here. Spawning
    // nothing used to leave the MR open forever — the follow-up now just lands it.
    const result = await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1', originalTask: { id: 'task-1' },
      prUrl: 'https://gitlab.com/group/proj/-/merge_requests/5', prBranch: 'feat/x', sourceWorkspace: '/ws'
    });
    expect(result.metadata.reviewLoopMergeOnly).toBe(true);
    expect(result.metadata.reviewLoopReviewers).toEqual([]);
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('should default priority to MEDIUM when originalTask omits it', async () => {
    await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1',
      originalTask: { id: 'task-1', metadata: {}, description: 'X' },
      prUrl: 'https://github.com/o/r/pull/9', prBranch: 'cos/task-1/agent-1', sourceWorkspace: '/ws'
    });
    expect(addTask.mock.calls[0][0].priority).toBe('MEDIUM');
  });

  it('leaves `app` nullish for a PortOS-local source task so it never reaches the task file', async () => {
    // `app: null` used to serialize into the task file as the bare word `null`
    // and re-parse as the app id 'null', which prepareAgentWorkspace blocks with
    // `app-unresolved` — so the PR this follow-up exists to merge sat open
    // forever. Most visible on slashdo-free providers (grok/opencode), where the
    // follow-up IS the entire merge path. generateTasksMarkdown drops nullish
    // metadata, so what matters is that nothing truthy lands here.
    await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1',
      originalTask: { id: 'task-1', metadata: {}, description: 'X' },
      prUrl: 'https://github.com/o/r/pull/9', prBranch: 'cos/task-1/agent-1', sourceWorkspace: '/ws'
    });
    expect(addTask.mock.calls[0][0].metadata.app).toBeUndefined();
  });

  it('carries `app` through when the source task is routed to a managed app', async () => {
    await spawnReviewLoopFollowUp({
      originalAgentId: 'agent-1',
      originalTask: { id: 'task-1', metadata: { app: 'example-app' }, description: 'X' },
      prUrl: 'https://github.com/o/r/pull/9', prBranch: 'cos/task-1/agent-1', sourceWorkspace: '/ws'
    });
    expect(addTask.mock.calls[0][0].metadata.app).toBe('example-app');
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

// The throwaway-worktree posture (programmatic-I/O reasoning agents, e.g.
// layered-intelligence) is the "reasoner can't land code" safety guarantee:
// the worktree is discarded with NO merge and NO PR even when openPR is set, so
// a reasoning agent that touched code can never push it. Derived inside the sink
// from originalTask.metadata.discardWorktree. These lock the behavior, not just
// the config default (taskSchedule.test.js pins the default).
describe('cleanupAgentWorktree - discardWorktree (throwaway reasoning worktree)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgent.mockResolvedValue(mockWorktreeAgent());
    git.getRepoBranches.mockResolvedValue({ baseBranch: 'main', devBranch: null });
  });

  it('removes the worktree with merge:false and never pushes/opens a PR — even with openPR:true', async () => {
    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always',
      originalTask: { metadata: { discardWorktree: true } }
    });

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    // `discardDirt` is part of the posture, not an optimization: the discard
    // prompt invites scratch edits, and removeWorktree otherwise ABORTS on dirt
    // — stranding one full checkout per run.
    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false, discardDirt: true });
    // Discard wins over openPR — no code is ever pushed or PR'd.
    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
  });

  it('treats the re-parsed string "true" as discard (metadata round-trips through the task store)', async () => {
    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always',
      originalTask: { metadata: { discardWorktree: 'true' } }
    });

    expect(removeWorktree).toHaveBeenCalledWith('agent-1', '/mock/workspace', 'cos/task-abc123', { merge: false, discardDirt: true });
    expect(git.push).not.toHaveBeenCalled();
    expect(git.createPR).not.toHaveBeenCalled();
  });

  it('does NOT discard when the flag is absent — the normal openPR path still runs', async () => {
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/9' });

    await cleanupAgentWorktree('agent-1', true, {
      prCreation: 'always',
      originalTask: { metadata: {} }
    });

    // No discard → the standard openPR flow pushes + creates a PR.
    expect(git.push).toHaveBeenCalled();
    expect(git.createPR).toHaveBeenCalled();
  });
});

// A completing agent reaches cleanup TWICE by design — the runner path
// (`handleAgentCompletion` → `runAgentCompletionCleanup`) and the spawner's
// unconditional `finally` safety net. Driven by independent events, the two
// overlapped: the loser read `git status --porcelain` while the winner was
// mid-`git worktree remove --force`, saw the in-progress deletions as dirt, and
// reported "Worktree preserved — uncommitted changes detected" for a worktree
// that removed cleanly (observed on agent-ce67bb09, whose PR had already merged).
describe('cleanupAgentWorktree — re-entrancy (duplicate completion paths)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queuePendingMergeMock.mockResolvedValue(false);
    getAgent.mockResolvedValue(mockWorktreeAgent());
    git.getRepoBranches.mockResolvedValue({ baseBranch: 'main', devBranch: null });
    git.push.mockResolvedValue(undefined);
    git.createPR.mockResolvedValue({ success: true, url: 'https://github.com/test/repo/pull/1' });
    git.generatePRDescription.mockResolvedValue('body');
    git.suggestPRTitle.mockResolvedValue('title');
  });

  it('coalesces two overlapping cleanups of the SAME agent into one pass', async () => {
    // Park the first pass INSIDE removeWorktree so the second call provably
    // lands mid-flight — the exact interleaving that produced the false warning.
    // `removeCalled` is what makes it provable: releasing on a bare microtask
    // tick would fire before the pass had even reached removeWorktree.
    let releaseRemove;
    const removeCalled = new Promise((signalCalled) => {
      removeWorktree.mockImplementation(() => new Promise((res) => {
        releaseRemove = () => res({ merged: false, removed: true, warnings: [] });
        signalCalled();
      }));
    });

    const first = cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });
    await removeCalled;
    const second = cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

    releaseRemove();
    const [firstWarnings, secondWarnings] = await Promise.all([first, second]);

    // ONE removal, ONE push, ONE PR — the duplicate caller joined the pass.
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.createPR).toHaveBeenCalledTimes(1);
    // ...and both callers observe the same verdict, so neither can report a
    // "preserved" warning the other's run never produced.
    expect(secondWarnings).toEqual(firstWarnings);
  });

  // The guard is keyed per agent — two agents finishing together must NOT be
  // collapsed into one cleanup. `prCreation: 'never'` keeps this on the plain merge
  // path so it asserts the keying and nothing else.
  it('does NOT coalesce across different agents', async () => {
    // Park each pass inside removeWorktree so both are in flight at once, and
    // parking keeps the post-removal follow-up machinery out of the test.
    const reached = [];
    const arrivals = [];
    removeWorktree.mockImplementation((agentId) => new Promise(() => {
      reached.push(agentId);
      arrivals.shift()?.();
    }));
    const nextArrival = () => new Promise((res) => { arrivals.push(res); });

    // B starts only once A is parked. A is still in flight, so this is the
    // overlap the guard has to distinguish — started sequentially so the two
    // passes don't race the lazy module graph and make the test flaky.
    const aParked = nextArrival();
    cleanupAgentWorktree('agent-A', true, { prCreation: 'never' });
    await aParked;
    const bParked = nextArrival();
    cleanupAgentWorktree('agent-B', true, { prCreation: 'never' });
    await bParked;

    expect(reached).toEqual(['agent-A', 'agent-B']);
  });

  it('releases the guard so a LATER cleanup of the same agent still runs', async () => {
    removeWorktree.mockResolvedValue({ merged: false, removed: true, warnings: [] });

    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });
    await cleanupAgentWorktree('agent-1', true, { prCreation: 'always' });

    expect(removeWorktree).toHaveBeenCalledTimes(2);
  });

  // A failing removal is reported as a warning, not a throw — so the joiner must
  // receive that SAME warning rather than re-deriving its own verdict from a
  // worktree the failed pass may have left half-removed.
  it('gives the joiner the same warnings when the pass FAILS, and still releases the guard', async () => {
    let releaseRemove;
    const removeCalled = new Promise((signalCalled) => {
      removeWorktree.mockImplementation(() => new Promise((_res, rej) => {
        releaseRemove = () => rej(new Error('git exploded'));
        signalCalled();
      }));
    });

    const first = cleanupAgentWorktree('agent-1', true, { prCreation: 'never' });
    await removeCalled;
    const second = cleanupAgentWorktree('agent-1', true, { prCreation: 'never' });
    releaseRemove();

    const [firstWarnings, secondWarnings] = await Promise.all([first, second]);
    expect(firstWarnings.join(' ')).toContain('git exploded');
    expect(secondWarnings).toEqual(firstWarnings);
    expect(removeWorktree).toHaveBeenCalledTimes(1);

    // Guard cleared → a later cleanup is not wedged on the failed pass.
    removeWorktree.mockResolvedValue({ merged: false, removed: true, warnings: [] });
    await cleanupAgentWorktree('agent-1', true, { prCreation: 'never' });
    expect(removeWorktree).toHaveBeenCalledTimes(2);
  });
});
