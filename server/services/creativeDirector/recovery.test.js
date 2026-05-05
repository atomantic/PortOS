import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before importing the module under test.
const mockListProjects = vi.fn();
const mockUpdateScene = vi.fn();
const mockUpdateRun = vi.fn();
const mockUpdateProject = vi.fn();
const mockAdvance = vi.fn();
const mockListJobs = vi.fn();
const mockCancelJob = vi.fn();
const mockUpdateTask = vi.fn();

vi.mock('./local.js', () => ({
  listProjects: (...args) => mockListProjects(...args),
  updateScene: (...args) => mockUpdateScene(...args),
  updateRun: (...args) => mockUpdateRun(...args),
  updateProject: (...args) => mockUpdateProject(...args),
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
  mockUpdateProject.mockReset().mockResolvedValue({ ok: true });
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
    // Use a queuedAt well in the past so the recovery-window filter
    // treats them as pre-recovery snapshot entries.
    const longAgo = new Date(Date.now() - 600000).toISOString();
    mockListProjects.mockResolvedValue([
      { id: 'cd-paused', status: 'paused', treatment: { scenes: [] }, runs: [] },
    ]);
    mockListJobs.mockReturnValue([
      { id: 'job-orphan-1', status: 'queued', owner: 'cd:cd-paused:scene-2', queuedAt: longAgo },
      { id: 'job-orphan-2', status: 'queued', owner: 'cd:cd-paused:scene-3', queuedAt: longAgo },
      { id: 'job-other', status: 'queued', owner: 'cd:cd-other:scene-1', queuedAt: longAgo },
      { id: 'job-no-owner', status: 'queued', owner: null, queuedAt: longAgo },
    ]);
    await recoverInFlightProjects();
    expect(mockCancelJob).toHaveBeenCalledTimes(2);
    expect(mockCancelJob).toHaveBeenCalledWith('job-orphan-1');
    expect(mockCancelJob).toHaveBeenCalledWith('job-orphan-2');
  });

  it('skips orphan-cancel for jobs queued AFTER recovery started (user resumed mid-recovery)', async () => {
    // recoverInFlightProjects is fire-and-forget — the user can click
    // Resume on a paused project and enqueue a fresh render between the
    // listProjects() snapshot and this orphan-cancel loop. That fresh
    // job has queuedAt > recoveryStartedAt and must NOT be canceled.
    const veryRecentFuture = new Date(Date.now() + 60000).toISOString(); // queued "after" recovery start
    const longAgo = new Date(Date.now() - 600000).toISOString();
    mockListProjects.mockResolvedValue([
      { id: 'cd-paused', status: 'paused', treatment: { scenes: [] }, runs: [] },
    ]);
    mockListJobs.mockReturnValue([
      { id: 'job-stale', status: 'queued', owner: 'cd:cd-paused:scene-1', queuedAt: longAgo },
      { id: 'job-fresh', status: 'queued', owner: 'cd:cd-paused:scene-2', queuedAt: veryRecentFuture },
    ]);
    await recoverInFlightProjects();
    expect(mockCancelJob).toHaveBeenCalledTimes(1);
    expect(mockCancelJob).toHaveBeenCalledWith('job-stale');
    expect(mockCancelJob).not.toHaveBeenCalledWith('job-fresh');
  });

  it('also cancels queued jobs for recovering (non-paused) projects to prevent double-render races', async () => {
    // Recovery resets stuck scenes to `pending` and advance() will enqueue
    // a fresh render — leaving the prior queued job alive would race two
    // completions for the same `cd:<projectId>:<sceneId>` owner.
    const longAgo = new Date(Date.now() - 600000).toISOString();
    mockListProjects.mockResolvedValue([
      { id: 'cd-rendering', status: 'rendering', treatment: { scenes: [] }, runs: [] },
    ]);
    mockListJobs.mockReturnValue([
      { id: 'job-orphan', status: 'queued', owner: 'cd:cd-rendering:scene-1', queuedAt: longAgo },
    ]);
    await recoverInFlightProjects();
    expect(mockCancelJob).toHaveBeenCalledWith('job-orphan');
  });

  it('cancels orphaned jobs that have already moved from queued → running by the time recovery runs', async () => {
    // initMediaJobQueue() starts the worker before recovery executes, so
    // restored queued jobs may already be running when listJobs() is
    // called here. Recovery must SIGTERM those too via cancelJob — not
    // just queued — otherwise the dead-listener render keeps burning GPU
    // and the freshly-enqueued sibling fights it for memory.
    const longAgo = new Date(Date.now() - 600000).toISOString();
    mockListProjects.mockResolvedValue([
      { id: 'cd-rendering', status: 'rendering', treatment: { scenes: [] }, runs: [] },
    ]);
    mockListJobs.mockReturnValue([
      { id: 'job-running', status: 'running', owner: 'cd:cd-rendering:scene-1', queuedAt: longAgo },
      { id: 'job-completed', status: 'completed', owner: 'cd:cd-rendering:scene-2', queuedAt: longAgo }, // terminal — must NOT cancel
      { id: 'job-failed', status: 'failed', owner: 'cd:cd-rendering:scene-3', queuedAt: longAgo }, // terminal — must NOT cancel
    ]);
    await recoverInFlightProjects();
    expect(mockCancelJob).toHaveBeenCalledTimes(1);
    expect(mockCancelJob).toHaveBeenCalledWith('job-running');
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
    // taskType MUST be 'internal' — CD tasks are added via addTask(record, 'internal').
    // Passing 'cos' would write to the wrong file and silently strip approval flags.
    // status MUST be 'completed' — generateTasksMarkdown only serializes
    // pending/in_progress/blocked/completed; writing 'failed' would drop
    // the task from COS-TASKS.md entirely. Metadata audit-trails the
    // restart so the orphan-task reset still finds nothing to retry.
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'task-treatment-abc',
      expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({ interruptedByRestart: 'true' }) }),
      'internal',
    );
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'task-eval-def',
      expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({ interruptedByRestart: 'true' }) }),
      'internal',
    );
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

  it('resumes stitching-state projects (final concat interrupted) by flipping back to rendering first', async () => {
    // advanceAfterSceneSettled bails out early when status === 'stitching'
    // (its in-flight stitch dedup guard), so without flipping the status
    // back to 'rendering' here the recovery would silently leave the
    // project frozen at "all scenes accepted, no finalVideoId, never
    // re-stitched" — needing manual JSON edits to escape.
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'stitching',
        finalVideoId: null,
        treatment: { scenes: [{ sceneId: 's1', status: 'accepted', renderedJobId: 'job-1' }] },
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockUpdateProject).toHaveBeenCalledWith('cd-1', { status: 'rendering' });
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('does NOT flip stitching → rendering when finalVideoId is already set (stitch already finished, just status not flipped)', async () => {
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'stitching',
        finalVideoId: 'final-job-1',
        treatment: { scenes: [{ sceneId: 's1', status: 'accepted', renderedJobId: 'job-1' }] },
      },
    ]);
    await recoverInFlightProjects();
    expect(mockUpdateProject).not.toHaveBeenCalled();
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
