/**
 * Tests for agentCompletionCleanup.handlePipelineProgression — the
 * pipeline-stage advancement extracted out of handleAgentCompletion.
 *
 * Pins the four branches: not-running (no-op), stage failure (mark failed),
 * last stage (mark completed), and advance (enqueue the next stage task).
 * These were previously exercised only indirectly via the agentLifecycle
 * completion path; the extraction gives them a direct home.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cosAgents.js', () => ({ updateAgent: vi.fn() }));
vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue({}),
  addTask: vi.fn().mockResolvedValue({}),
  reviveBlockedTask: vi.fn().mockResolvedValue({}),
  checkStagePrecondition: vi.fn().mockReturnValue({ passed: true }),
  getAgent: vi.fn().mockResolvedValue(null),
}));
vi.mock('./jira.js', () => ({ getInstances: vi.fn(), addComment: vi.fn() }));
vi.mock('./git.js', () => ({ push: vi.fn(), getRepoBranches: vi.fn(), generatePRDescription: vi.fn(), suggestPRTitle: vi.fn(), createPR: vi.fn(), checkout: vi.fn() }));
vi.mock('./codeReview.js', () => ({ resolveReviewLoopOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn().mockResolvedValue([]),
  spawnMergeRecoveryTask: vi.fn(),
  releaseRetryHold: vi.fn().mockResolvedValue({}),
}));
vi.mock('./taskPromptService.js', () => ({ getStagePrompt: vi.fn().mockResolvedValue('do stage work in {appName}') }));

import { handlePipelineProgression, runAgentCompletionCleanup } from './agentCompletionCleanup.js';
import { updateTask, addTask, reviveBlockedTask, getAgent } from './cos.js';
import { cleanupAgentWorktree, releaseRetryHold } from './agentWorktreeCleanup.js';

const runningPipeline = (overrides = {}) => ({
  id: 'p1',
  status: 'running',
  currentStage: 0,
  stages: [{ name: 'stage-0' }, { name: 'stage-1' }],
  stageResults: [],
  ...overrides,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('handlePipelineProgression', () => {
  it('is a no-op when the pipeline is not running', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline({ status: 'completed' }) } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('marks the pipeline failed on a failed stage and does not advance', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', false);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask.mock.calls[0][1].metadata.pipeline.status).toBe('failed');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('marks the pipeline completed after the last stage', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline({ currentStage: 1 }) } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask.mock.calls[0][1].metadata.pipeline.status).toBe('completed');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('enqueues the next stage task when advancing', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(addTask).toHaveBeenCalledTimes(1);
    const [nextTask, group] = addTask.mock.calls[0];
    expect(group).toBe('internal');
    expect(nextTask.metadata.pipeline.currentStage).toBe(1);
    expect(nextTask.metadata.pipeline.status).toBe('running');
    expect(nextTask.metadata.pipeline.previousStageAgentId).toBe('agent-1');
  });

  it('propagates the next stage provider/model/effort pins into the enqueued task', async () => {
    const stages = [{ name: 'stage-0' }, { name: 'stage-1', providerId: 'codex', model: 'gpt-5', effort: 'xhigh' }];
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline({ stages }) } };
    await handlePipelineProgression(task, 'agent-1', true);
    const [nextTask] = addTask.mock.calls[0];
    expect(nextTask.metadata.provider).toBe('codex');
    expect(nextTask.metadata.providerId).toBe('codex');
    expect(nextTask.metadata.model).toBe('gpt-5');
    expect(nextTask.metadata.effort).toBe('xhigh');
  });

  it('leaves effort unset when the next stage has no effort pin', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    const [nextTask] = addTask.mock.calls[0];
    expect(nextTask.metadata.effort).toBeUndefined();
  });

  it('inherits a task-level effort into a stage that has no effort pin of its own', async () => {
    // Effort is SET-only on hand-off: a task-level effort (from the interval
    // config) must reach stage 1+ via the metadata carry-forward, not be wiped.
    const task = { id: 't', taskType: 'user', metadata: { effort: 'high', pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    const [nextTask] = addTask.mock.calls[0];
    expect(nextTask.metadata.effort).toBe('high');
  });

  it('revives a blocked duplicate stage task instead of silently dropping the advance (#2614)', async () => {
    // Stage prompts interpolate only app fields, so two runs of the same
    // pipeline collide on the dedup scan — which now also matches blocked
    // tasks. A stale blocked stage task from an earlier run must be revived
    // with the fresh pipeline state, not swallow the advance.
    addTask.mockResolvedValue({ id: 'sys-stale-stage', status: 'blocked', duplicate: true });
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(reviveBlockedTask).toHaveBeenCalledTimes(1);
    const [taskId, updates, group] = reviveBlockedTask.mock.calls[0];
    expect(taskId).toBe('sys-stale-stage');
    expect(updates.metadata.pipeline.currentStage).toBe(1);
    expect(updates.metadata.pipeline.previousStageAgentId).toBe('agent-1');
    expect(group).toBe('internal');
  });

  it('skips the advance without reviving when the duplicate stage task is still active (#2614)', async () => {
    addTask.mockResolvedValue({ id: 'sys-live-stage', status: 'pending', duplicate: true });
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(reviveBlockedTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });
});

// #3114 — `agentOwnsPR` decides whether PortOS skips its own push+PR because the
// agent was told to run `/do:pr` itself. It MUST derive from the same
// `canTypeSlashCommands` predicate the prompt's `hasSlashdo` gate used: when the
// two disagree, PortOS fires `gh pr create` on a branch that already has a PR
// ("a pull request already exists" preserves the worktree as a false-positive
// failure), or conversely never opens the PR the agent was told not to open.
describe('runAgentCompletionCleanup — agentOwnsPR mirrors the prompt gate', () => {
  const prTask = { id: 't', taskType: 'user', metadata: { openPR: true } };

  const cleanupCallFor = async (agent) => {
    await runAgentCompletionCleanup({
      agentId: 'a1', task: prTask, agent, effectiveSuccess: true, outputBuffer: '',
    });
    // cleanupAgentWorktree(agentId, success, options) — options is the 3rd arg.
    return cleanupAgentWorktree.mock.calls.at(-1)[2];
  };

  it.each([
    ['claude-code', 'claude', false],
    ['claude-code-bedrock', 'claude', false],
    // The case an id allowlist missed: a path-configured claude under a custom id
    // IS told to run /do:pr, so PortOS must not open a second PR.
    ['my-custom-agent', '/opt/homebrew/bin/claude', false],
  ])('%s does not double-fire the PR (agent owns it)', async (providerId, providerCommand) => {
    const opts = await cleanupCallFor({ providerId, providerCommand, leanMode: false });
    expect(opts.openPR).toBe(false);
    expect(opts.skipMerge).toBe(true);
  });

  it.each([
    ['codex', 'codex'],
    ['antigravity-cli', 'agy'],
  ])('%s still gets PortOS post-exit push+PR (agent cannot run /do:pr)', async (providerId, providerCommand) => {
    const opts = await cleanupCallFor({ providerId, providerCommand, leanMode: false });
    expect(opts.openPR).toBe(true);
    expect(opts.skipMerge).toBe(false);
  });

  it('a lean --bare claude session does NOT own its PR (it has no project commands)', async () => {
    const opts = await cleanupCallFor({ providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true });
    expect(opts.openPR).toBe(true);
  });

  it('a pre-upgrade agent record with only providerId still resolves', async () => {
    // Records written before providerCommand/leanMode were persisted: a blank
    // command reads as `claude`, which is what the old id allowlist effectively
    // assumed for the claude-code ids anyway.
    expect((await cleanupCallFor({ providerId: 'claude-code' })).openPR).toBe(false);
    expect((await cleanupCallFor({ providerId: 'codex-tui' })).openPR).toBe(true);
  });
});

// Runner mode shares the resume-pointer gate with the direct-CLI and TUI spawn
// paths (#3368) — it must call the helper, not keep its own inline copy.
describe('runAgentCompletionCleanup — resume pointer', () => {
  const task = { id: 't', taskType: 'user', metadata: {} };

  it('hands the verdict and the already-loaded agent metadata to the shared helper', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: true, sourceWorkspace: '/repo' } });

    await runAgentCompletionCleanup({
      agentId: 'a1', task, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    });

    expect(releaseRetryHold).toHaveBeenCalledWith({
      agentId: 'a1', task, success: false,
      agentMetadata: { isWorktree: true, sourceWorkspace: '/repo' },
    });
    // After cleanup, so the pointer reflects what actually survived.
    expect(cleanupAgentWorktree.mock.invocationCallOrder[0])
      .toBeLessThan(releaseRetryHold.mock.invocationCallOrder[0]);
  });

  // A missing agent record must reach the helper as an explicit null, not
  // `undefined` — `undefined` is the helper's "go read it yourself" sentinel, and
  // re-reading here would re-split the whole output.txt transcript for nothing.
  it('passes null when the agent record could not be read', async () => {
    getAgent.mockResolvedValue(null);

    await runAgentCompletionCleanup({
      agentId: 'a1', task, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    });

    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ agentMetadata: null }));
  });

  // The release is what makes a held task spawnable again (#3373), so it cannot
  // hang off the worktree-cleanup branch: a JIRA-branch task skips that block
  // entirely, and previously skipped the pointer with it.
  it('still releases the hold for a JIRA-branch task, which skips worktree cleanup', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: true, sourceWorkspace: '/repo' } });
    const jiraTask = { id: 't', taskType: 'user', metadata: { jiraTicketId: 'ABC-1', jiraBranch: 'feature/ABC-1' } };

    await runAgentCompletionCleanup({
      agentId: 'a1', task: jiraTask, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    });

    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', success: false }));
  });

  // ...and a throw from any earlier cleanup step must not strand the task held.
  it('releases the hold even when a cleanup step throws', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: true } });
    cleanupAgentWorktree.mockRejectedValueOnce(new Error('git exploded'));

    await expect(runAgentCompletionCleanup({
      agentId: 'a1', task, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    })).rejects.toThrow('git exploded');

    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
  });
});
