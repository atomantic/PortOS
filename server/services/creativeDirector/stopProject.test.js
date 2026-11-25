import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerLateBoundService } from '../../lib/lateBoundServices.js';
import { mediaJobEvents } from '../mediaJobQueue/state.js';
import { autopilotEvents } from '../pipeline/seriesAutopilot/state.js';
import { resolveCreativeDirectorProjectCommand } from './projectCommands.js';

registerLateBoundService('agentManagement', () => import('../agent/agentManagement.js'));
registerLateBoundService('creativeToolRegistry', async () => ({ dispatchCreativeTool: dispatchMock }));

const getProjectMock = vi.fn();
const updateProjectMock = vi.fn(async () => ({}));
const updateRunMock = vi.fn(async () => ({}));
const updateSceneMock = vi.fn(async () => ({}));
const updatePlanStepMock = vi.fn(async () => ({}));
const recordRunMock = vi.fn();
vi.mock('./local.js', () => ({
  getProject: (...a) => getProjectMock(...a),
  mutateVideoProject: async (_id, mutate) => { const result = mutate(await getProjectMock(_id)); getProjectMock.mockResolvedValue(result.project); return result; },
  updateProject: (...a) => updateProjectMock(...a),
  updateRun: (...a) => updateRunMock(...a),
  updateScene: (...a) => updateSceneMock(...a),
  updatePlanStep: (...a) => updatePlanStepMock(...a),
  recordRun: (...a) => recordRunMock(...a),
}));

vi.mock('../instanceIdentity.js', () => ({ getInstanceId: async () => 'example-owner' }));

const getActiveAgentsMock = vi.fn(() => []);
const killAgentMock = vi.fn(async () => ({ success: true }));
vi.mock('../agent/agentManagement.js', () => ({
  getActiveAgents: (...a) => getActiveAgentsMock(...a),
  killAgent: (...a) => killAgentMock(...a),
}));

const updateTaskMock = vi.fn(async () => ({}));
vi.mock('../cos/cosTaskStore.js', () => ({ updateTask: (...a) => updateTaskMock(...a) }));

const listJobsMock = vi.fn(() => []);
const cancelJobMock = vi.fn(async () => ({}));
vi.mock('../mediaJobQueue/index.js', async () => ({
  mediaJobEvents: (await import('../mediaJobQueue/state.js')).mediaJobEvents,
  getJob: () => null,
  listJobs: (...a) => listJobsMock(...a),
  cancelJob: (...a) => cancelJobMock(...a),
}));

const enqueueMock = vi.fn();
const dispatchMock = vi.fn();
vi.mock('../settings.js', () => ({
  getSettings: async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } }),
}));
vi.mock('../federatedMedia/defaultRouting.js', () => ({
  enqueueUnattendedMediaJob: (...args) => enqueueMock(...args),
  hasConfiguredMediaRoute: async () => false,
}));
vi.mock('../pipeline/seriesAutopilot/session.js', () => ({ isAutopilotActive: () => true }));
vi.mock('./videoReview.js', () => ({ videoReviewAllowsDispatch: async () => true }));
vi.mock('./videoExecution.js', async (importOriginal) => ({
  ...await importOriginal(),
  enqueueVideoProductionJob: async () => ({ jobId: 'pending-job', attemptId: 'clip-attempt' }),
}));

const { stopProject, retireRuns, inflightRuns, ownedLiveJobs } = await import('./stopProject.js');
const { clearSceneRenderListeners, runSceneRender } = await import('./sceneRunner.js');
const { clearPlanListenersForProject } = await import('./planAdvance.js');
const { startCreativeDirectorProject } = await import('./completionHook.js');

const project = (over = {}) => ({ id: 'cd-1', status: 'planning', runs: [], ...over });

beforeEach(() => {
  vi.resetAllMocks();
  getActiveAgentsMock.mockReturnValue([]);
  listJobsMock.mockReturnValue([]);
});

afterEach(() => {
  clearSceneRenderListeners('cd-1');
  clearPlanListenersForProject('cd-1');
});

describe('inflightRuns', () => {
  it('keeps only non-terminal run rows', () => {
    const runs = [
      { runId: 'a', status: 'completed' },
      { runId: 'b', status: 'failed' },
      { runId: 'c', status: 'running' },
      { runId: 'd' },
    ];
    expect(inflightRuns({ runs }).map((r) => r.runId)).toEqual(['c', 'd']);
  });

  it('tolerates a project with no runs', () => {
    expect(inflightRuns(null)).toEqual([]);
    expect(inflightRuns({})).toEqual([]);
  });

  it('narrows to the requested kinds — an LLM-stage caller must not sweep up a render step', () => {
    const runs = [
      { runId: 'a', kind: 'plan', status: 'running' },
      { runId: 'b', kind: 'plan-step', status: 'running' },
      { runId: 'c', kind: 'treatment', status: 'running' },
      { runId: 'd', kind: 'plan', status: 'completed' },
    ];
    expect(inflightRuns({ runs }, ['treatment', 'plan']).map((r) => r.runId)).toEqual(['a', 'c']);
  });
});

describe('retireRuns', () => {
  it('kills the agent, retires the internal task, and settles the run — without touching the project or its jobs', async () => {
    getActiveAgentsMock.mockReturnValue([{ id: 'agent-live', taskId: 't1' }]);

    const result = await retireRuns('cd-1', {
      runs: [{ runId: 'r1', taskId: 't1', status: 'running' }],
      reason: 'Commission provider changed to lmstudio-tui',
    });

    expect(killAgentMock).toHaveBeenCalledExactlyOnceWith('agent-live');
    expect(updateTaskMock).toHaveBeenCalledExactlyOnceWith(
      't1',
      expect.objectContaining({ status: 'completed' }),
      'internal',
    );
    expect(updateRunMock).toHaveBeenCalledExactlyOnceWith('cd-1', 'r1', expect.objectContaining({
      status: 'failed', failureReason: 'Commission provider changed to lmstudio-tui',
    }));
    // The restart path re-advances the project itself — retireRuns must not park it.
    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(cancelJobMock).not.toHaveBeenCalled();
    expect(result).toEqual({ runs: 1, tasks: 1, agents: 1 });
  });

  it('is a no-op with nothing to retire', async () => {
    const result = await retireRuns('cd-1', { runs: [] });
    expect(getActiveAgentsMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalled();
    expect(result).toEqual({ runs: 0, tasks: 0, agents: 0 });
  });
});

describe('ownedLiveJobs', () => {
  it('matches all three ownership conventions and only live jobs', () => {
    const jobs = [
      { id: 'j1', owner: 'cd-1', status: 'queued' },                    // not an owner form
      { id: 'j2', owner: 'cd:cd-1:scene-1', status: 'queued' },
      { id: 'j3', owner: 'creative-director:cd-1', status: 'running' },
      { id: 'j4', owner: 'cd:cd-1:scene-2', status: 'completed' },      // terminal
      { id: 'j5', owner: 'cd:cd-2:scene-1', status: 'queued' },         // other project
      { id: 'j6', status: 'queued' },                                   // ownerless, untagged
      // First-pass seed frames carry NO owner — they're tagged in params. A
      // 10-scene project enqueues ten of these up front, so missing them means
      // "Stop" cancels nothing on exactly the projects with the most queued work.
      { id: 'j7', status: 'queued', params: { creativeDirector: { projectId: 'cd-1', sceneId: 's1' } } },
      { id: 'j8', status: 'running', params: { creativeDirector: { projectId: 'cd-2' } } }, // other project
      { id: 'j9', status: 'completed', params: { creativeDirector: { projectId: 'cd-1' } } }, // terminal
      // The music bed uses a THIRD tag and is a music commission's entire
      // deliverable — missing it means Stop cancels nothing on those projects.
      { id: 'j10', status: 'running', params: { creativeDirectorMusicBed: { projectId: 'cd-1' } } },
      { id: 'j11', status: 'queued', params: { creativeDirectorMusicBed: { projectId: 'cd-2' } } },
    ];
    expect(ownedLiveJobs(jobs, 'cd-1').map((j) => j.id)).toEqual(['j2', 'j3', 'j7', 'j10']);
  });
});

describe('stopProject', () => {
  it('is a no-op for a missing project', async () => {
    getProjectMock.mockResolvedValue(null);
    const result = await stopProject('cd-gone');
    expect(result).toMatchObject({ stopped: false, skipped: 'missing' });
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it('never rewrites a terminal project', async () => {
    getProjectMock.mockResolvedValue(project({ status: 'complete' }));
    const result = await stopProject('cd-1');
    expect(result).toMatchObject({ stopped: false, skipped: 'terminal' });
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it('tears down an already-paused project without rewriting its status or reason', async () => {
    // Pause is soft — the render and agent keep going — so Stop on a paused
    // project still has work to retire; only the park write is already done.
    getProjectMock.mockResolvedValue(project({ status: 'paused', runs: [{ runId: 'r1', taskId: 't1', status: 'running' }] }));
    getActiveAgentsMock.mockReturnValue([{ id: 'agent-live', taskId: 't1' }]);
    const result = await stopProject('cd-1', { reason: 'Stopped by user' });
    expect(result).toMatchObject({ stopped: true, runs: 1, agents: 1 });
    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(killAgentMock).toHaveBeenCalledWith('agent-live');
  });

  it('parks the project, then settles the run, then kills — so neither the settle nor the kill echo can un-park it', async () => {
    const order = [];
    updateProjectMock.mockImplementation(async () => { order.push('park'); });
    updateRunMock.mockImplementation(async () => { order.push('settle-run'); });
    killAgentMock.mockImplementation(async () => { order.push('kill'); return { success: true }; });
    getProjectMock.mockResolvedValue(project({ runs: [{ runId: 'r1', taskId: 't1', status: 'running' }] }));
    getActiveAgentsMock.mockReturnValue([{ id: 'agent-live', taskId: 't1' }]);

    await stopProject('cd-1', { reason: 'Commission deleted' });

    // The run must be terminal before the kill: killAgent fires the agent
    // completion path, whose `!success` branch would otherwise flip the project to
    // `failed`. completionHook's stale-completion guard keys on that terminal row.
    expect(order).toEqual(['park', 'settle-run', 'kill']);
    expect(updateProjectMock).toHaveBeenCalledExactlyOnceWith('cd-1', { status: 'paused', failureReason: 'Commission deleted' });
  });

  it('kills live agents, retires the internal tasks, settles runs, and cancels media jobs', async () => {
    getProjectMock.mockResolvedValue(project({
      runs: [
        { runId: 'r1', taskId: 'cd-1-plan-a', status: 'running' },
        { runId: 'r2', taskId: 'cd-1-plan-old', status: 'completed' },
      ],
    }));
    getActiveAgentsMock.mockReturnValue([
      { id: 'agent-live', taskId: 'cd-1-plan-a' },
      { id: 'agent-other', taskId: 'unrelated-task' },
    ]);
    listJobsMock.mockReturnValue([
      { id: 'j2', owner: 'cd:cd-1:scene-1', status: 'running' },
      { id: 'j5', owner: 'cd:cd-2:scene-1', status: 'queued' },
    ]);

    const result = await stopProject('cd-1', { reason: 'Creative commission paused' });

    expect(killAgentMock).toHaveBeenCalledExactlyOnceWith('agent-live');
    // 'internal' + a supported terminal status — see recovery.js for why both matter.
    expect(updateTaskMock).toHaveBeenCalledExactlyOnceWith(
      'cd-1-plan-a',
      expect.objectContaining({ status: 'completed' }),
      'internal',
    );
    // Only the in-flight run is settled; the already-completed one is untouched.
    expect(updateRunMock).toHaveBeenCalledExactlyOnceWith('cd-1', 'r1', expect.objectContaining({
      status: 'failed', failureReason: 'Creative commission paused',
    }));
    expect(cancelJobMock).toHaveBeenCalledExactlyOnceWith('j2');
    expect(result).toMatchObject({ stopped: true, runs: 1, tasks: 1, agents: 1, jobs: 1 });
  });

  it('resets the stage state it cancelled, so the project is actually Resumable', async () => {
    // A plan step left `running` makes deriveNextPlanAction return `waiting`
    // forever; a scene left `rendering` points at a job we just cancelled. Without
    // the reset, Resume is dead until the next server restart.
    getProjectMock.mockResolvedValue(project({
      plan: { steps: [
        { stepId: 's-run', status: 'running' },
        { stepId: 's-done', status: 'done' },
      ] },
      treatment: { scenes: [
        { sceneId: 'sc-1', status: 'rendering' },
        { sceneId: 'sc-2', status: 'evaluating', renderedJobId: 'job-9' }, // finished render — keep
        { sceneId: 'sc-3', status: 'accepted' },
      ] },
    }));

    await stopProject('cd-1');

    expect(updatePlanStepMock).toHaveBeenCalledExactlyOnceWith('cd-1', 's-run', { status: 'pending' });
    // Only the scene with no landed render is reset — resetting sc-2 would throw
    // away a finished video (same carve-out recovery.js makes).
    expect(updateSceneMock).toHaveBeenCalledExactlyOnceWith('cd-1', 'sc-1', { status: 'pending' });
  });

  it('completes the stop when a single step fails', async () => {
    getProjectMock.mockResolvedValue(project({ runs: [{ runId: 'r1', taskId: 't1', status: 'running' }] }));
    getActiveAgentsMock.mockReturnValue([{ id: 'agent-live', taskId: 't1' }]);
    killAgentMock.mockRejectedValue(new Error('agent gone'));
    updateTaskMock.mockRejectedValue(new Error('task file busy'));
    listJobsMock.mockReturnValue([{ id: 'j2', owner: 'creative-director:cd-1', status: 'queued' }]);

    const result = await stopProject('cd-1');

    // A failed kill/retire must not abort the rest of the teardown.
    expect(updateRunMock).toHaveBeenCalled();
    expect(cancelJobMock).toHaveBeenCalledWith('j2');
    expect(result).toMatchObject({ stopped: true, agents: 0, tasks: 0, jobs: 1 });
  });

  it('skips the agent/task teardown entirely when no run carries a taskId', async () => {
    getProjectMock.mockResolvedValue(project({ runs: [{ runId: 'r1', kind: 'plan-step', status: 'running' }] }));
    await stopProject('cd-1');
    expect(getActiveAgentsMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith('cd-1', 'r1', expect.objectContaining({ status: 'failed' }));
  });

  it.each(['scene', 'scene with a queued cancellation', 'media step', 'media step with a queued cancellation', 'autopilot step'])('detaches the %s listener at Stop and dispatches again on Resume', async (kind) => {
    const isScene = kind.startsWith('scene');
    const queuedCancellation = kind.endsWith('queued cancellation');
    const isAutopilot = kind === 'autopilot step';
    const saved = project({ status: 'rendering', aspectRatio: '16:9', quality: 'standard',
      ...(isScene ? { treatment: { scenes: [{ sceneId: 'sc-1', order: 0, durationSeconds: 6, status: 'pending' }] } }
        : { directive: { goal: 'Create a clip' }, plan: { steps: [{
          stepId: 'step-1', status: 'pending', args: { seriesId: 'series-1' }, dependsOn: [],
          toolName: isAutopilot ? 'pipeline_startSeriesAutopilot' : 'media_enqueueVideoJob',
        }] } }),
    });
    const stage = isScene ? saved.treatment.scenes[0] : saved.plan.steps[0];
    getProjectMock.mockImplementation(async () => structuredClone(saved));
    updateProjectMock.mockImplementation(async (_id, patch) => Object.assign(saved, patch));
    updateSceneMock.mockImplementation(async (_id, _sceneId, patch) => Object.assign(stage, patch));
    updatePlanStepMock.mockImplementation(async (_id, _stepId, patch) => Object.assign(stage, patch));
    recordRunMock.mockImplementation(async (_id, entry) => {
      const run = { ...entry, runId: `run-${saved.runs.length + 1}` };
      saved.runs.push(run);
      return run;
    });
    updateRunMock.mockImplementation(async (_id, runId, patch) => Object.assign(saved.runs.find(run => run.runId === runId), patch));
    enqueueMock.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
    dispatchMock.mockResolvedValueOnce({ ok: true, longRunning: true,
      result: isAutopilot ? { runId: 'autopilot-1' } : { jobId: 'job-1' },
    }).mockResolvedValueOnce({ ok: true, longRunning: true,
      result: isAutopilot ? { runId: 'autopilot-2' } : { jobId: 'job-2' },
    });

    const job = { id: 'job-1', status: 'running', owner: 'creative-director:cd-1' };
    listJobsMock.mockReturnValue([job]);
    const emitter = isAutopilot ? autopilotEvents : mediaJobEvents;
    const event = isAutopilot ? 'series-1' : 'canceled';
    const baseline = emitter.listenerCount(event);
    cancelJobMock.mockImplementationOnce(async () => {
      expect(emitter.listenerCount(event)).toBe(baseline);
      mediaJobEvents.emit('canceled', { ...job, status: 'canceled' });
      if (isAutopilot) autopilotEvents.emit(event, { type: 'canceled', runId: 'autopilot-1' });
    });
    await startCreativeDirectorProject(saved.id);
    expect(emitter.listenerCount(event)).toBe(baseline + 1);

    const delayedRead = Promise.withResolvers();
    if (queuedCancellation) {
      const readStarted = Promise.withResolvers();
      getProjectMock.mockImplementationOnce(() => {
        readStarted.resolve();
        return delayedRead.promise;
      });
      mediaJobEvents.emit('canceled', { ...job, status: 'canceled' });
      await readStarted.promise;
    }
    expect(await stopProject(saved.id)).toMatchObject({ stopped: true, jobs: 1 });
    expect(saved.status).toBe('paused');
    expect(stage.status).toBe('pending');

    const resume = resolveCreativeDirectorProjectCommand(saved, 'resume');
    expect(resume).toMatchObject({ outcome: 'apply', advance: true });
    await updateProjectMock(saved.id, resume.patch);
    await startCreativeDirectorProject(saved.id);
    if (queuedCancellation) {
      delayedRead.resolve(structuredClone(saved));
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(isScene ? enqueueMock : dispatchMock).toHaveBeenCalledTimes(2);
    expect(stage.status).toBe(isScene ? 'rendering' : 'running');
    expect(emitter.listenerCount(event)).toBe(baseline + 1);
  });
});

it('revokes Video authorization before canceling jobs and retains completed clips', async () => {
  const video = project({ workspace: 'video', videoOwnerInstanceId: 'example-owner', videoWorkRevision: 2,
    aspectRatio: '16:9', quality: 'standard',
    videoExecution: { authorized: true, attempts: [{ id: 'agent-attempt', kind: 'treatment', status: 'running' }] },
    treatment: { scenes: [{ sceneId: 'pending-shot', order: 0, durationSeconds: 6, status: 'pending', workRevision: 3 }, { sceneId: 'done-shot', order: 1, status: 'evaluating', renderedJobId: 'done-job', workRevision: 1 }] },
  });
  getProjectMock.mockResolvedValue(video);
  const shot = video.treatment.scenes[0];
  updateSceneMock.mockImplementation(async (_id, _sceneId, patch) => Object.assign(shot, patch));
  const job = { id: 'pending-job', status: 'running', owner: 'cd:cd-1:pending-shot' };
  const baseline = mediaJobEvents.listenerCount('canceled');
  expect(await runSceneRender(video, shot)).toBe(job.id);
  expect(mediaJobEvents.listenerCount('canceled')).toBe(baseline + 1);
  updateSceneMock.mockClear();
  listJobsMock.mockReturnValue([job, { id: 'unrelated-job', status: 'running', owner: 'other' }]);
  cancelJobMock.mockImplementationOnce(async () => {
    const saved = await getProjectMock('cd-1');
    expect(saved.status).toBe('paused');
    expect(saved.videoExecution.authorized).toBe(false);
    expect(saved.videoWorkRevision).toBe(3);
    expect(saved.treatment.scenes[0].workRevision).toBe(4);
    expect(mediaJobEvents.listenerCount('canceled')).toBe(baseline);
    mediaJobEvents.emit('canceled', { ...job, status: 'canceled' });
  });
  const stderr = vi.spyOn(console, 'error');
  try {
    expect(await stopProject('cd-1')).toMatchObject({ stopped: true, jobs: 1 });
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
  }
  expect(cancelJobMock).toHaveBeenCalledExactlyOnceWith('pending-job');
  expect(updateSceneMock).toHaveBeenCalledExactlyOnceWith('cd-1', 'pending-shot', { status: 'pending', renderedJobId: null });
  expect((await getProjectMock('cd-1')).videoExecution.attempts[0].status).toBe('failed');
});
