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
  checkStagePrecondition: vi.fn().mockReturnValue({ passed: true }),
  getAgent: vi.fn().mockResolvedValue(null),
}));
vi.mock('./jira.js', () => ({ getInstances: vi.fn(), addComment: vi.fn() }));
vi.mock('./git.js', () => ({ push: vi.fn(), getRepoBranches: vi.fn(), generatePRDescription: vi.fn(), suggestPRTitle: vi.fn(), createPR: vi.fn(), checkout: vi.fn() }));
vi.mock('./codeReview.js', () => ({ resolveReviewLoopOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('./agentWorktreeCleanup.js', () => ({ cleanupAgentWorktree: vi.fn().mockResolvedValue([]), spawnMergeRecoveryTask: vi.fn() }));
vi.mock('./taskPromptService.js', () => ({ getStagePrompt: vi.fn().mockResolvedValue('do stage work in {appName}') }));

import { handlePipelineProgression } from './agentCompletionCleanup.js';
import { updateTask, addTask } from './cos.js';

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
    expect(updateTask).toHaveBeenCalledTimes(1);
    const [taskId, updates, group] = updateTask.mock.calls[0];
    expect(taskId).toBe('sys-stale-stage');
    expect(updates.status).toBe('pending');
    expect(updates.metadata.pipeline.currentStage).toBe(1);
    expect(updates.metadata.pipeline.previousStageAgentId).toBe('agent-1');
    expect(group).toBe('internal');
  });

  it('skips the advance without reviving when the duplicate stage task is still active (#2614)', async () => {
    addTask.mockResolvedValue({ id: 'sys-live-stage', status: 'pending', duplicate: true });
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
