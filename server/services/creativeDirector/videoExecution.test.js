import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ project: null, jobs: [], settings: null, tracks: [] }));
vi.mock('./local.js', () => ({
  getProject: vi.fn(async () => structuredClone(state.project)),
  mutateVideoProject: vi.fn(async (_id, mutate) => {
    const output = await mutate(structuredClone(state.project));
    if (!output.skipPersist) state.project = output.project;
    return output;
  }),
}));
vi.mock('../instances.js', () => ({ getInstanceId: vi.fn(async () => 'example-owner') }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => state.settings) }));
vi.mock('./videoSources.js', () => ({ assertVideoSourcesAvailable: vi.fn(async () => {}) }));
vi.mock('./agentBridge.js', () => ({ getStageAssignment: vi.fn(async () => ({ providerId: 'example-agent', provider: 'example-agent', model: 'example-model' })) }));
vi.mock('../agentProviderResolution.js', () => ({ resolveAgentProviderAndModel: vi.fn(async () => ({ ok: true, provider: { id: 'example-agent' }, selectedModel: 'example-model' })) }));
vi.mock('./sceneEvaluator.js', () => ({ resolveVisionEvalTarget: vi.fn(async () => null) }));
vi.mock('../videoGen/reactor.js', () => ({ REACTOR_MODEL_ID: 'fast-h3' }));
vi.mock('../videoGen/modelSelection.js', () => ({ resolveVideoModelSelection: vi.fn() }));
vi.mock('../mediaJobQueue/index.js', () => ({ listJobs: vi.fn(() => state.jobs), getJob: vi.fn(id => state.jobs.find(job => job.id === id)),
  enqueueJob: vi.fn(job => { const jobId = `example-audio-${state.jobs.length}`; state.jobs.push({ ...job, id: jobId, status: 'completed', result: { filename: 'example-bed.wav', durationSec: 10 } }); return { jobId }; }),
}));
vi.mock('../pipeline/musicGen.js', () => ({ ENGINES: { 'example-audio': { id: 'example-audio', models: [{ id: 'example-model' }], defaultModelId: 'example-model', minDurationSec: 1, maxDurationSec: 30 } }, isEngineHealthy: vi.fn(async () => true) }));
vi.mock('../pipeline/audioMux.js', () => ({ resolveMusicTrackPath: vi.fn(async filename => filename ? `/fake/music/${filename}` : null) }));
vi.mock('../tracks/index.js', () => ({ listTracks: async () => state.tracks, createTrack: async input => { const track = { id: 'example-track', ...input }; state.tracks.push(track); return track; } }));
vi.mock('../federatedMedia/defaultRouting.js', () => ({
  hasConfiguredMediaRoute: vi.fn(async () => false),
  enqueueUnattendedMediaJob: vi.fn(async job => {
    const id = `example-job-${state.jobs.length + 1}`;
    state.jobs.push({ ...job, id, status: 'queued' });
    return { jobId: id };
  }),
}));
vi.mock('./completionHook.js', () => ({ startCreativeDirectorProject: vi.fn(async () => {}) }));
const { startCreativeDirectorProject } = await import('./completionHook.js');
const { enqueueUnattendedMediaJob, hasConfiguredMediaRoute } = await import('../federatedMedia/defaultRouting.js');
const { resolveVideoModelSelection } = await import('../videoGen/modelSelection.js');
import { getVideoExecutionPreview, startVideoExecution, enqueueVideoProductionJob, pauseVideoExecution,
  reconcileVideoExecution, reserveVideoAttempt, settleVideoAttempt, assertVideoAttemptDispatch, videoConfigurationRevision } from './videoExecution.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.jobs = [];
  state.tracks = [];
  state.settings = { videoGen: { reactor: { apiKey: 'example-key' } } };
  state.project = { id: 'example-video', workspace: 'video', videoOwnerInstanceId: 'example-owner',
    status: 'draft', userStory: 'An invented woodland journey.', videoDraft: { sources: [], audio: {} },
    renderBackend: { video: { mode: 'reactor' } }, aspectRatio: '16:9', targetDurationSeconds: 10,
    treatment: { scenes: [{ sceneId: 'opening', order: 0, status: 'pending', workRevision: 0 }] } };
  hasConfiguredMediaRoute.mockResolvedValue(false);
});
const startInput = async (limits = {}, extra = {}) => ({ configurationRevision: (await getVideoExecutionPreview('example-video')).configurationRevision, limits, ...extra });
const enqueue = () => enqueueVideoProductionJob(state.project, { params: { mode: 'reactor', prompt: 'Example landscape', seconds: 10 }, sceneId: 'opening', workRevision: state.project.treatment.scenes[0].workRevision });

it('previews cloud choices without local hardware or paid calls and makes Start idempotent', async () => {
  const preview = await getVideoExecutionPreview('example-video');
  expect(preview).toMatchObject({ canStart: true, choices: { video: { mode: 'reactor', modelDescription: 'fast-h3' }, costEstimateUsd: null } });
  expect(resolveVideoModelSelection).not.toHaveBeenCalled();
  expect(enqueueUnattendedMediaJob).not.toHaveBeenCalled();
  expect(startCreativeDirectorProject).not.toHaveBeenCalled();
  const input = await startInput({ maxClips: 2, maxRetries: 0 });
  await startVideoExecution('example-video', input);
  await startVideoExecution('example-video', input);
  expect(startCreativeDirectorProject).toHaveBeenCalledTimes(1);
  expect(state.project.videoExecution).toMatchObject({ authorized: true, limits: { maxClips: 2, maxRetries: 0 }, inputRevision: videoConfigurationRevision(state.project) });
});

it('does not expose a stale legacy audio blocker for a native Video draft', async () => {
  const blocker = 'The reactor video backend cannot honor audio-disabled output.';
  state.project.videoExecution = { blocker };
  expect((await getVideoExecutionPreview('example-video')).execution.blocker).toBeNull();

  state.project.videoDraft.audio = { mode: 'silent' };
  expect((await getVideoExecutionPreview('example-video')).execution.blocker).toBe(blocker);
});

it('refuses stale choices, unavailable pinned credentials and unenforceable dollar caps', async () => {
  const input = await startInput();
  state.project.userStory = 'A changed brief.';
  await expect(startVideoExecution('example-video', input)).rejects.toMatchObject({ code: 'VIDEO_START_STALE' });
  await expect(startVideoExecution('example-video', await startInput({ spendCapUsd: 5 }))).rejects.toMatchObject({ code: 'VIDEO_COST_UNKNOWN' });
  state.settings = {};
  vi.stubEnv('REACTOR_API_KEY', '');
  expect(await getVideoExecutionPreview('example-video')).toMatchObject({ canStart: false, choices: null });
  vi.unstubAllEnvs();
  expect(startCreativeDirectorProject).not.toHaveBeenCalled();
});

it('resumes a shot whose preflight failed before creating a submission receipt', async () => {
  state.project.status = 'paused';
  state.project.treatment.scenes[0].status = 'rendering';
  state.project.treatment.scenes[0].renderedJobId = null;
  await startVideoExecution('example-video', await startInput());
  expect(state.project.treatment.scenes[0].status).toBe('pending');
  expect(startCreativeDirectorProject).toHaveBeenCalledTimes(1);
  expect(await enqueue()).toMatchObject({ jobId: 'example-job-1' });
});

it('resumes failed shots without erasing retries, receipts or accepted work', async () => {
  await startVideoExecution('example-video', await startInput({ maxRetries: 0 }));
  const queued = await enqueue();
  state.jobs[0].status = 'failed';
  state.project.status = 'paused';
  Object.assign(state.project.treatment.scenes[0], { status: 'failed', retryCount: 1, renderedJobId: queued.jobId });
  state.project.treatment.scenes.push({ sceneId: 'accepted', status: 'accepted', renderedJobId: 'saved-clip' },
    { sceneId: 'legacy-failed', status: 'failed', retryCount: 1 });
  await startVideoExecution('example-video', await startInput({ maxRetries: 0 }));
  expect(state.project.treatment.scenes[0]).toMatchObject({ status: 'pending', retryCount: 1, renderedJobId: null });
  expect(state.project.treatment.scenes[1]).toMatchObject({ status: 'accepted', renderedJobId: 'saved-clip' });
  expect(state.project.treatment.scenes[2]).toMatchObject({ status: 'pending', retryCount: 1 });
  expect(await enqueue()).toBeNull();
  expect(state.project.videoExecution.blocker).toMatch(/retry limit/);
  expect(state.project.videoExecution.attempts).toHaveLength(1);
});

it('reserves before enqueue, binds one queue ID, enforces retry bounds and pauses dispatch', async () => {
  await startVideoExecution('example-video', await startInput({ maxClips: 2, maxRetries: 0 }));
  const queued = await enqueue();
  expect(state.project.videoExecution.attempts[0]).toMatchObject({ id: queued.attemptId, jobId: queued.jobId, status: 'queued' });
  expect(await enqueue()).toBeNull();
  await assertVideoAttemptDispatch('example-video', queued.attemptId, { jobId: queued.jobId });
  await expect(assertVideoAttemptDispatch('example-video', queued.attemptId, { jobId: 'another-job' })).rejects.toMatchObject({ code: 'VIDEO_DISPATCH_BLOCKED' });
  await pauseVideoExecution('example-video', 'Paused');
  await expect(assertVideoAttemptDispatch('example-video', queued.attemptId, { jobId: queued.jobId })).rejects.toMatchObject({ code: 'VIDEO_DISPATCH_BLOCKED' });
  expect(await enqueue()).toBeNull();
  state.jobs[0].status = 'failed';
  state.jobs[0].error = 'Render failed';
  await startVideoExecution('example-video', await startInput({ maxClips: 2, maxRetries: 0 }));
  expect(await enqueue()).toBeNull();
  expect(state.project.videoExecution.blocker).toMatch(/retry limit/);
  expect(enqueueUnattendedMediaJob).toHaveBeenCalledTimes(1);
});

it('parks new dispatch on Pause while retaining the in-flight clip for Resume', async () => {
  await startVideoExecution('example-video', await startInput());
  const queued = await enqueue();
  await assertVideoAttemptDispatch('example-video', queued.attemptId, { jobId: queued.jobId });
  state.project.treatment.scenes[0].status = 'rendering';
  await pauseVideoExecution('example-video', 'Paused by the user.');
  expect(await enqueue()).toBeNull();
  expect(state.project.treatment.scenes[0].workRevision).toBe(0);
  state.jobs[0].status = 'completed';
  await settleVideoAttempt('example-video', queued.attemptId, { status: 'completed' });
  await startVideoExecution('example-video', await startInput());
  expect(state.project.treatment.scenes[0]).toMatchObject({ status: 'evaluating', renderedJobId: queued.jobId, workRevision: 0 });
  expect(enqueueUnattendedMediaJob).toHaveBeenCalledTimes(1);
});

it('keeps uncertain submissions inert until the user explicitly acknowledges a possible duplicate charge', async () => {
  await startVideoExecution('example-video', await startInput());
  enqueueUnattendedMediaJob.mockRejectedValueOnce(new Error('connection lost after submit'));
  await expect(enqueue()).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNCERTAIN' });
  const attempt = state.project.videoExecution.attempts[0];
  expect(attempt.status).toBe('uncertain');
  expect(state.project.status).toBe('paused');
  await expect(startVideoExecution('example-video', await startInput())).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNCERTAIN' });
  expect(enqueueUnattendedMediaJob).toHaveBeenCalledTimes(1);
  await startVideoExecution('example-video', await startInput({}, { retryAttemptIds: [attempt.id] }));
  expect(state.project.videoExecution.attempts[0].status).toBe('failed');
  expect(startCreativeDirectorProject).toHaveBeenCalledTimes(2);
});

it('reconciles completed clips without a rerender and requires Resume after restart', async () => {
  await startVideoExecution('example-video', await startInput());
  const queued = await enqueue();
  state.project.treatment.scenes[0].status = 'rendering';
  state.jobs[0].status = 'completed';
  await reconcileVideoExecution('example-video', { restarting: true });
  expect(state.project).toMatchObject({ status: 'paused', videoExecution: { authorized: false }, treatment: { scenes: [{ status: 'evaluating', renderedJobId: queued.jobId }] } });
  expect(enqueueUnattendedMediaJob).toHaveBeenCalledTimes(1);
  expect(startCreativeDirectorProject).toHaveBeenCalledTimes(1);
});

it('bounds planner calls and refuses stale or replica dispatch', async () => {
  await startVideoExecution('example-video', await startInput({ maxReplans: 0 }));
  const first = await reserveVideoAttempt('example-video', { kind: 'plan', key: 'plan:project' });
  await settleVideoAttempt('example-video', first.id, { status: 'failed' });
  expect(await reserveVideoAttempt('example-video', { kind: 'plan', key: 'plan:project' })).toBeNull();
  expect(state.project.videoExecution.blocker).toMatch(/replan limit/);
  state.project.videoReplica = true;
  await expect(startVideoExecution('example-video', await startInput())).rejects.toMatchObject({ code: 'VIDEO_START_BLOCKED' });
});


it('checks the duration the backend actually consumes and rejects batch expansion', async () => {
  await startVideoExecution('example-video', await startInput());
  await expect(enqueueVideoProductionJob(state.project, { sceneId: 'opening', workRevision: 0,
    params: { mode: 'fal', durationSeconds: 5, duration: 60, prompt: 'Example' } })).rejects.toMatchObject({ code: 'VIDEO_PLAN_CLIP_BOUNDS' });
  await expect(enqueueVideoProductionJob(state.project, { sceneId: 'opening', workRevision: 0,
    params: { mode: 'text', durationSeconds: 5, numFrames: 1440, fps: 24, prompt: 'Example' } })).rejects.toMatchObject({ code: 'VIDEO_PLAN_CLIP_BOUNDS' });
  // A clip within the queue bounds must still satisfy its pinned backend.
  await expect(enqueueVideoProductionJob({ ...state.project, renderBackend: { video: { mode: 'grok' } } }, {
    sceneId: 'opening', workRevision: 0, params: { mode: 'grok', duration: 5, prompt: 'Example' },
  })).rejects.toMatchObject({ code: 'VIDEO_BACKEND_INPUT_UNSUPPORTED' });
  expect(state.project.videoExecution.attempts).toHaveLength(0);
  expect(enqueueUnattendedMediaJob).not.toHaveBeenCalled();
});

it('generates one explicitly selected soundtrack, retains its Track, and reuses it within audio job limits', async () => {
  const { prepareVideoSoundtrack } = await import('./videoAudio.js');
  const { enqueueJob } = await import('../mediaJobQueue/index.js');
  state.project.videoDraft.audio = { mode: 'generated', providerId: 'example-audio', model: 'example-model', prompt: 'A quiet invented melody.' };
  await startVideoExecution('example-video', await startInput({ maxAudioJobs: 1 }));
  const bed = await prepareVideoSoundtrack(state.project, async () => true);
  expect(bed).toMatchObject({ filename: 'example-bed.wav', trackId: 'example-track' });
  expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio', owner: 'creative-director:example-video', params: expect.objectContaining({ engine: 'example-audio', modelId: 'example-model', durationSec: 10, videoProduction: expect.objectContaining({ projectId: 'example-video' }) }) }));
  expect(state.project.videoExecution.attempts.filter(attempt => attempt.kind === 'audio')).toHaveLength(1);
  await prepareVideoSoundtrack(state.project, async () => true);
  expect(enqueueJob).toHaveBeenCalledTimes(1);
  state.project.videoDraft.audio.prompt = 'A different melody.';
  state.project.status = 'paused';
  await startVideoExecution('example-video', await startInput({ maxAudioJobs: 1 }));
  expect(await prepareVideoSoundtrack(state.project, async () => true)).toBeNull();
  expect(state.project.videoExecution.blocker).toMatch(/audio job limit/);
  expect(enqueueJob).toHaveBeenCalledTimes(1);
});
