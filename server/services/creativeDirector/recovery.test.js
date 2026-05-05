import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before importing the module under test.
const mockListProjects = vi.fn();
const mockUpdateScene = vi.fn();
const mockUpdateRun = vi.fn();
const mockAdvance = vi.fn();
const mockListJobs = vi.fn();
const mockCancelJob = vi.fn();
const mockUpdateTask = vi.fn();

vi.mock('./local.js', () => ({
  listProjects: (...args) => mockListProjects(...args),
  updateScene: (...args) => mockUpdateScene(...args),
  updateRun: (...args) => mockUpdateRun(...args),
}));

vi.mock('./completionHook.js', () => ({
  advanceAfterSceneSettled: (...args) => mockAdvance(...args),
}));

vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: (...args) => mockListJobs(...args),
  cancelJob: (...args) => mockCancelJob(...args),
}));

vi.mock('../cos.js', () => ({
  updateTask: (...args) => mockUpdateTask(...args),
}));

const { recoverInFlightProjects } = await import('./recovery.js');

beforeEach(() => {
  mockListProjects.mockReset();
  mockUpdateScene.mockReset().mockResolvedValue(undefined);
  mockUpdateRun.mockReset().mockResolvedValue(undefined);
  mockAdvance.mockReset().mockResolvedValue(undefined);
  mockListJobs.mockReset().mockReturnValue([]);
  mockCancelJob.mockReset().mockResolvedValue({ ok: true, status: 'canceled' });
  mockUpdateTask.mockReset().mockResolvedValue({ ok: true });
});

describe('recoverInFlightProjects', () => {
  it('skips terminal and draft projects entirely', async () => {
    mockListProjects.mockResolvedValue([
      { id: 'cd-1', status: 'complete', treatment: { scenes: [{ sceneId: 's1', status: 'accepted' }] } },
      { id: 'cd-2', status: 'failed', treatment: { scenes: [{ sceneId: 's1', status: 'failed' }] } },
      { id: 'cd-3', status: 'draft', treatment: null },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(0);
    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockUpdateScene).not.toHaveBeenCalled();
  });

  it('cancels orphaned queued media-jobs owned by paused projects', async () => {
    // Without this, initMediaJobQueue() would happily restart a queued
    // render whose owner=cd:<projectId>:<sceneId> belongs to a paused
    // project, burning GPU on work the user explicitly stopped.
    mockListProjects.mockResolvedValue([
      { id: 'cd-paused', status: 'paused', treatment: { scenes: [] }, runs: [] },
    ]);
    mockListJobs.mockReturnValue([
      { id: 'job-orphan-1', status: 'queued', owner: 'cd:cd-paused:scene-2' },
      { id: 'job-orphan-2', status: 'queued', owner: 'cd:cd-paused:scene-3' },
      { id: 'job-other', status: 'queued', owner: 'cd:cd-other:scene-1' },
      { id: 'job-no-owner', status: 'queued', owner: null },
    ]);
    await recoverInFlightProjects();
    expect(mockCancelJob).toHaveBeenCalledTimes(2);
    expect(mockCancelJob).toHaveBeenCalledWith('job-orphan-1');
    expect(mockCancelJob).toHaveBeenCalledWith('job-orphan-2');
  });

  it('also cancels queued jobs for recovering (non-paused) projects to prevent double-render races', async () => {
    // Recovery resets stuck scenes to `pending` and advance() will enqueue
    // a fresh render — leaving the prior queued job alive would race two
    // completions for the same `cd:<projectId>:<sceneId>` owner.
    mockListProjects.mockResolvedValue([
      { id: 'cd-rendering', status: 'rendering', treatment: { scenes: [] }, runs: [] },
    ]);
    mockListJobs.mockReturnValue([
      { id: 'job-orphan', status: 'queued', owner: 'cd:cd-rendering:scene-1' },
    ]);
    await recoverInFlightProjects();
    expect(mockCancelJob).toHaveBeenCalledWith('job-orphan');
  });

  it('retires the underlying CoS task for each stale run so cos.js#resetOrphanedTasks does not respawn it', async () => {
    // Without retiring the CoS task, cos.js sees `in_progress` task rows
    // on boot and respawns them — racing the fresh treatment/evaluate task
    // recovery's advance() will enqueue.
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'planning',
        treatment: null,
        runs: [
          { runId: 'run-1', taskId: 'task-treatment-abc', kind: 'treatment', status: 'running' },
          { runId: 'run-2', taskId: 'task-eval-def', kind: 'evaluate', sceneId: 's1', status: 'running' },
          { runId: 'run-3', taskId: null, kind: 'evaluate', sceneId: 's2', status: 'running' }, // missing taskId — skip
        ],
      },
    ]);
    await recoverInFlightProjects();
    expect(mockUpdateTask).toHaveBeenCalledTimes(2);
    expect(mockUpdateTask).toHaveBeenCalledWith('task-treatment-abc', { status: 'failed' }, 'cos');
    expect(mockUpdateTask).toHaveBeenCalledWith('task-eval-def', { status: 'failed' }, 'cos');
  });

  it('cleans up paused projects but does NOT auto-advance them', async () => {
    // The user pressed Pause; we still need to wipe dead in-flight scene
    // state and stale running runs so a future Resume click finds a clean
    // slate. But we must NOT fire advance — that would burn agent time
    // before the user explicitly clicks Resume.
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-paused',
        status: 'paused',
        treatment: { scenes: [{ sceneId: 's1', status: 'evaluating' }] },
        runs: [{ runId: 'run-stale', kind: 'evaluate', sceneId: 's1', status: 'running' }],
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(0);
    expect(mockUpdateScene).toHaveBeenCalledWith('cd-paused', 's1', { status: 'pending' });
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-paused', 'run-stale', expect.objectContaining({
      status: 'failed',
      failureReason: 'interrupted by restart',
    }));
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('resets stuck rendering/evaluating scenes to pending and advances', async () => {
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'rendering',
        treatment: {
          scenes: [
            { sceneId: 's1', status: 'accepted' },
            { sceneId: 's2', status: 'rendering' },
            { sceneId: 's3', status: 'evaluating' },
            { sceneId: 's4', status: 'pending' },
          ],
        },
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockUpdateScene).toHaveBeenCalledTimes(2);
    expect(mockUpdateScene).toHaveBeenCalledWith('cd-1', 's2', { status: 'pending' });
    expect(mockUpdateScene).toHaveBeenCalledWith('cd-1', 's3', { status: 'pending' });
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('resumes planning-state projects (treatment task interrupted)', async () => {
    mockListProjects.mockResolvedValue([
      { id: 'cd-1', status: 'planning', treatment: null },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockUpdateScene).not.toHaveBeenCalled();
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('resumes stitching-state projects (final concat interrupted)', async () => {
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'stitching',
        treatment: { scenes: [{ sceneId: 's1', status: 'accepted', renderedJobId: 'job-1' }] },
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('reaps stale running runs[] rows so the persisted-runs guard does not block re-enqueue', async () => {
    // Regression: a project that restarted mid-treatment still has a
    // persisted `runs: [{ kind: 'treatment', status: 'running' }]` from
    // before the crash. Without reaping, advanceAfterSceneSettled's
    // hasInflightTreatmentRun guard would treat this as another worker on
    // it and refuse to enqueue a replacement, leaving the project frozen.
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'planning',
        treatment: null,
        runs: [
          { runId: 'run-completed', kind: 'treatment', status: 'completed' },
          { runId: 'run-stale-1', kind: 'treatment', status: 'running' },
          { runId: 'run-stale-2', kind: 'evaluate', sceneId: 's1', status: 'running' },
        ],
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockUpdateRun).toHaveBeenCalledTimes(2);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-stale-1', expect.objectContaining({
      status: 'failed',
      failureReason: 'interrupted by restart',
    }));
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-stale-2', expect.objectContaining({
      status: 'failed',
      failureReason: 'interrupted by restart',
    }));
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('handles multiple projects independently', async () => {
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'rendering',
        treatment: { scenes: [{ sceneId: 's1', status: 'rendering' }] },
      },
      {
        id: 'cd-2',
        status: 'rendering',
        treatment: { scenes: [{ sceneId: 's1', status: 'evaluating' }] },
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(2);
    expect(mockAdvance).toHaveBeenCalledTimes(2);
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
    expect(mockAdvance).toHaveBeenCalledWith('cd-2');
  });
});
