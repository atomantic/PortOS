/**
 * Music Video production run (#9066) — orchestration contract with injected
 * queue events. The project store is an in-memory double with the real
 * store's serialized read-modify-write; the queue, generation lanes and
 * review service are doubles; the checkpoint (production.js) and the pool
 * rules (productionPool.js) are real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ---- in-memory project store with a single write tail ----------------------
const store = new Map();
let writeTail = Promise.resolve();
const clone = (v) => JSON.parse(JSON.stringify(v));
vi.mock('./projects.js', () => ({
  getProject: async (id) => (store.has(id) ? clone(store.get(id)) : null),
  mutateProjectRecord: (id, transform) => {
    const run = writeTail.then(() => {
      if (!store.has(id)) throw Object.assign(new Error('Project not found'), { status: 404 });
      const out = transform(clone(store.get(id)));
      store.set(id, clone(out.project));
      return out;
    });
    writeTail = run.catch(() => {});
    return run;
  },
}));

const { musicVideoEvents } = await import('./events.js');
const service = await import('./productionService.js');

// ---- queue, lanes and review doubles ------------------------------------------
let jobs;
let nextJobId;
const mediaJobEvents = new EventEmitter();
const queue = {
  listJobs: ({ kind } = {}) => jobs.filter((j) => !kind || j.kind === kind),
  cancelJob: vi.fn(async (id) => {
    const job = jobs.find((j) => j.id === id);
    if (job) job.status = 'canceled';
  }),
  mediaJobEvents,
};
const dispatch = vi.fn();
const planProject = vi.fn();
const startAutoReview = vi.fn();
const autoReview = { startAutoReview, resumeAutoReview: vi.fn(), stopAutoReview: vi.fn(async () => {}), cancelAutoReview: vi.fn(async () => {}) };

const env = {
  settings: { imageGen: { local: { pythonPath: '/opt/example/python' }, codex: { enabled: true, model: 'codex-image' }, grok: { enabled: false } } },
  imageModels: [{ id: 'flux2-dev', runner: 'flux2' }, { id: 'sd-basic', runner: 'mflux' }],
  resolveVideoModel: async (id) => ({ model: id === 'ltx-example' ? { id } : null }),
  isVideoModeUsable: (_settings, mode) => mode === 'local',
};

const POOL = [
  { kind: 'image', mode: 'local', model: 'flux2-dev' },
  { kind: 'image', mode: 'codex', model: null },
  { kind: 'video', mode: 'local', model: 'ltx-example' },
];
const LIMITS = { maxGenerations: 10, maxReviewAttempts: 2 };

function seedProject(overrides = {}) {
  const project = {
    id: 'mv-example',
    name: 'Example Video',
    concept: { style: 'noir' },
    audioAnalysis: { sections: [{ startSec: 0, endSec: 8, label: 'Verse' }], durationSec: 8 },
    scenes: [
      { sceneId: 'mvs-a', label: 'A', framePrompt: 'a lighthouse', prompt: 'waves roll', startSec: 0, endSec: 4, takes: [] },
      { sceneId: 'mvs-b', label: 'B', framePrompt: 'a harbor', prompt: 'boats sway', startSec: 4, endSec: 8, takes: [] },
    ],
    ...overrides,
  };
  store.set(project.id, project);
  return project;
}

const current = () => clone(store.get('mv-example'));
const theRun = () => current().productionRuns[0];
const liveSteps = () => theRun().steps.filter((s) => s.status === 'reserved' || s.status === 'queued');

// The queue double: a dispatch lands one queued job tagged with the step.
const enqueueing = ({ stepKind, tag }) => {
  const id = `job-${nextJobId += 1}`;
  jobs.push({ id, kind: stepKind === 'frame' ? 'image' : 'video', status: 'queued', queuedAt: new Date().toISOString(), params: { musicVideo: tag } });
  return Promise.resolve({ jobId: id });
};

/** Complete a job and file its take the way the scene hooks do, then emit the hook event. */
function completeJob(jobId) {
  const job = jobs.find((j) => j.id === jobId);
  job.status = 'completed';
  const project = store.get('mv-example');
  const scene = project.scenes.find((s) => s.sceneId === job.params.musicVideo.sceneId);
  if (job.kind === 'image') scene.referenceImageId = `${jobId}.png`;
  else scene.videoHistoryId = jobId;
  mediaJobEvents.emit('completed', job);
  musicVideoEvents.emit(job.kind === 'image' ? 'scene-image' : 'scene-video', { projectId: 'mv-example', sceneId: scene.sceneId });
}

const settle = async () => {
  // Let fire-and-forget listeners reach their advance, then wait for it.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  const run = store.get('mv-example')?.productionRuns?.[0];
  if (run) await service.__advanceProductionForTests('mv-example', run.id);
};

async function start(input = {}) {
  const out = await service.startProduction('mv-example', { directive: 'moody, slow', pool: POOL, limits: LIMITS, reviewer: {}, ...input });
  await settle();
  return out;
}

beforeEach(() => {
  store.clear();
  jobs = [];
  nextJobId = 0;
  vi.clearAllMocks();
  dispatch.mockImplementation(enqueueing);
  planProject.mockResolvedValue({ scenesAdded: 0 });
  startAutoReview.mockImplementation(async (projectId, input) => {
    const reviewRun = { id: 'mvar-example', status: 'running', productionRunId: input.productionRunId, limits: input.limits, usage: { reviews: 0, generations: 0 } };
    const project = store.get(projectId);
    project.autoReviews = [...(project.autoReviews || []), reviewRun];
    return { run: reviewRun };
  });
  service.__setProductionDepsForTests({
    loadEnv: async () => env,
    dispatch,
    queue: async () => queue,
    planProject,
    autoReview: async () => autoReview,
    releaseRevisionSection: vi.fn(async () => {}),
  });
});

// A test's background advances finish before the next test resets the doubles.
afterEach(settle);

describe('music video production run (#9066)', () => {
  it('produces a reviewed draft from one Start: frames, then clips, then the continuous-excerpt review', async () => {
    seedProject();
    await start();
    // Both frames go out on the first eligible pool route; clips wait for their frame.
    expect(dispatch.mock.calls.map(([a]) => [a.stepKind, a.scene.sceneId, a.route.mode])).toEqual([
      ['frame', 'mvs-a', 'local'], ['frame', 'mvs-b', 'local'],
    ]);
    expect(dispatch.mock.calls[0][0].tag).toMatchObject({ projectId: 'mv-example', sceneId: 'mvs-a', productionRunId: theRun().id });

    completeJob('job-1');
    completeJob('job-2');
    await settle();
    expect(dispatch.mock.calls.slice(2).map(([a]) => [a.stepKind, a.scene.sceneId, a.route.mode])).toEqual([
      ['clip', 'mvs-a', 'local'], ['clip', 'mvs-b', 'local'],
    ]);

    completeJob('job-3');
    completeJob('job-4');
    await settle();
    expect(startAutoReview).toHaveBeenCalledTimes(1);
    expect(startAutoReview.mock.calls[0][1]).toMatchObject({ startSec: 0, endSec: 8, productionRunId: theRun().id, limits: { maxAttempts: 2, maxGenerations: 6 } });
    expect(theRun()).toMatchObject({ status: 'running', reviewRunId: 'mvar-example', usage: { generations: 4 } });
    expect(theRun().steps.every((s) => s.status === 'completed' && s.rationale)).toBe(true);

    // Only a passed continuous review completes the run — never the frames alone.
    store.get('mv-example').autoReviews[0].status = 'passed';
    musicVideoEvents.emit('auto-review', { projectId: 'mv-example', run: { ...store.get('mv-example').autoReviews[0] }, action: { type: 'idle' } });
    await settle();
    expect(theRun().status).toBe('completed');
  });

  it('plans an empty board once, with the directive, before generating', async () => {
    seedProject({ scenes: [] });
    planProject.mockImplementation(async () => {
      store.get('mv-example').scenes = [{ sceneId: 'mvs-p', framePrompt: 'x', prompt: 'y', startSec: 0, endSec: 4, takes: [] }];
      return { scenesAdded: 1 };
    });
    await start();
    expect(planProject).toHaveBeenCalledWith('mv-example', { seedPrompts: true, directive: 'moody, slow' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses a route outside the allowed pool before anything is enqueued', async () => {
    seedProject();
    const chooseRoute = vi.fn(async () => ({ route: { kind: 'image', mode: 'grok', model: null }, rationale: 'model pick' }));
    service.__setProductionDepsForTests({ loadEnv: async () => env, dispatch, queue: async () => queue, planProject, autoReview: async () => autoReview, chooseRoute });
    await start();
    expect(dispatch).not.toHaveBeenCalled();
    expect(theRun()).toMatchObject({ status: 'blocked', usage: { generations: 0 } });
    expect(theRun().stopReason).toMatch(/not in this run's allowed pool/);
  });

  it('lets the chooser pick any eligible member of the pool', async () => {
    seedProject();
    const chooseRoute = vi.fn(async () => ({ route: { kind: 'image', mode: 'codex', model: null }, rationale: 'model pick' }));
    service.__setProductionDepsForTests({ loadEnv: async () => env, dispatch, queue: async () => queue, planProject, autoReview: async () => autoReview, chooseRoute });
    await start();
    expect(dispatch.mock.calls.map(([a]) => a.route.mode)).toEqual(['codex', 'codex']);
    expect(theRun().steps[0].rationale).toBe('model pick');
  });

  it('refuses Start when a pool route lacks entitlement (disabled cloud backend, missing local model)', async () => {
    seedProject();
    await expect(service.startProduction('mv-example', {
      pool: [{ kind: 'image', mode: 'grok' }, { kind: 'video', mode: 'local', model: 'not-installed' }], limits: LIMITS,
    })).rejects.toMatchObject({ code: 'PRODUCTION_ROUTE_INELIGIBLE', message: expect.stringMatching(/grok.*not enabled.*not-installed.*not installed/s) });
    expect(current().productionRuns).toBeUndefined();
  });

  it('skips a route that cannot condition on the visual-spec references', async () => {
    seedProject({ visualSpec: { references: [{ imageId: 'ref.png', condition: true }] } });
    await start({ pool: [{ kind: 'image', mode: 'local', model: 'sd-basic' }, { kind: 'image', mode: 'codex' }, POOL[2]] });
    expect(dispatch.mock.calls.map(([a]) => a.route.mode)).toEqual(['codex', 'codex']);
    expect(theRun().steps[0].rationale).toMatch(/skipped 1 earlier route.*cannot use reference images/);
  });

  it('halts with the capability reason when no pool route can condition on the references', async () => {
    seedProject({ visualSpec: { references: [{ imageId: 'ref.png', condition: true }] } });
    await start({ pool: [{ kind: 'image', mode: 'local', model: 'sd-basic' }, POOL[2]] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(theRun()).toMatchObject({ status: 'blocked', stopReason: expect.stringMatching(/cannot use reference images/) });
  });

  it('refuses a performance shot on a pool with no lip-sync video route, naming why', async () => {
    seedProject();
    store.get('mv-example').scenes[0].shotMode = 'performance';
    await start();
    completeJob('job-1');
    completeJob('job-2');
    await settle();
    expect(theRun()).toMatchObject({ status: 'blocked', stopReason: expect.stringMatching(/cannot lip-sync/) });
    expect(dispatch.mock.calls.some(([a]) => a.stepKind === 'clip' && a.scene.sceneId === 'mvs-a')).toBe(false);
  });

  it('settles a duplicated completion event once and never re-dispatches for it', async () => {
    seedProject();
    await start();
    const job = jobs[0];
    job.status = 'failed';
    job.error = 'out of memory';
    mediaJobEvents.emit('failed', job);
    mediaJobEvents.emit('failed', job);
    await settle();
    const steps = theRun().steps.filter((s) => s.sceneId === 'mvs-a');
    expect(steps.map((s) => s.status)).toEqual(['failed', 'queued']);
    // One retry for the failed slot, not one per duplicate event.
    expect(dispatch.mock.calls.filter(([a]) => a.scene.sceneId === 'mvs-a')).toHaveLength(2);
  });

  it('halts a slot that keeps failing, and a resume retries it', async () => {
    seedProject();
    await start();
    const fail = (id) => {
      const job = jobs.find((j) => j.id === id);
      job.status = 'failed';
      mediaJobEvents.emit('failed', job);
    };
    fail('job-1');
    await settle();
    fail('job-3');
    await settle();
    expect(theRun()).toMatchObject({ status: 'blocked', stopReason: expect.stringMatching(/"A" failed to generate its frame 2 times/) });
    const before = dispatch.mock.calls.length;
    await service.resumeProduction('mv-example', theRun().id);
    await settle();
    expect(dispatch.mock.calls.slice(before).map(([a]) => a.scene.sceneId)).toEqual(['mvs-a']);
  });

  it('coalesces concurrent advances so each slot is dispatched once', async () => {
    seedProject();
    let release;
    const gate = new Promise((r) => { release = r; });
    dispatch.mockImplementation(async (args) => { await gate; return enqueueing(args); });
    const started = service.startProduction('mv-example', { pool: POOL, limits: LIMITS });
    const { run } = await started;
    const racing = Promise.all([1, 2, 3].map(() => service.__advanceProductionForTests('mv-example', run.id)));
    release();
    await racing;
    await settle();
    expect(dispatch.mock.calls.map(([a]) => a.scene.sceneId)).toEqual(['mvs-a', 'mvs-b']);
    expect(jobs).toHaveLength(2);
  });

  it('never re-dispatches a slot the queue already has a live job for (lost link after enqueue)', async () => {
    seedProject();
    jobs.push({ id: 'job-orphan', kind: 'image', status: 'running', params: { musicVideo: { projectId: 'mv-example', sceneId: 'mvs-a' } } });
    await start();
    expect(dispatch.mock.calls.map(([a]) => a.scene.sceneId)).toEqual(['mvs-b']);
  });

  it('Stop during a dispatch cancels the job that raced it and dispatches nothing more', async () => {
    seedProject();
    let release;
    const gate = new Promise((r) => { release = r; });
    dispatch.mockImplementationOnce(async (args) => { await gate; return enqueueing(args); });
    const { run } = await service.startProduction('mv-example', { pool: POOL, limits: LIMITS });
    await new Promise((r) => setTimeout(r, 0));
    await service.stopProduction('mv-example', run.id);
    release();
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(queue.cancelJob).toHaveBeenCalledWith('job-1');
    expect(jobs[0].status).toBe('canceled');
    expect(theRun()).toMatchObject({ status: 'stopped' });
    // Evidence stays: the step and its charge are kept.
    expect(theRun().steps).toHaveLength(1);
  });

  it('stops at the generation limit instead of paying for the next job', async () => {
    seedProject();
    await start({ limits: { maxGenerations: 1, maxReviewAttempts: 1 } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(theRun()).toMatchObject({ status: 'limit-reached', usage: { generations: 1 } });
  });

  it('refuses a dollar cap when a metered route has no known price', async () => {
    seedProject();
    await expect(service.startProduction('mv-example', { pool: POOL, limits: { ...LIMITS, spendCapUsd: 5 } }))
      .rejects.toMatchObject({ code: 'PRODUCTION_COST_UNKNOWN' });
    // A local-only pool prices every route at $0, so the cap is enforceable.
    await service.startProduction('mv-example', { pool: [POOL[0], POOL[2]], limits: { ...LIMITS, spendCapUsd: 5 } });
    await settle();
    expect(theRun().limits.spendCapUsd).toBe(5);
  });

  it('prices fal.ai clips from the catalog so a dollar cap bounds them, charging each scene its own take', async () => {
    // Scene A is a 4s performance (lip-sync window padded to 5.05s), B a 4s
    // cutaway on H3 Max (covered by its 5s minimum), both at 1080P list rates.
    seedProject({
      videoSettings: { backend: 'fal', falModelId: 'minimax/h3-max/image-to-video', falResolution: '1080P' },
      audioAnalysis: { sections: [{ startSec: 0, endSec: 8, label: 'Verse' }], durationSec: 30 },
    });
    store.get('mv-example').scenes[0].shotMode = 'performance';
    const falPool = [POOL[0], { kind: 'video', mode: 'fal', model: null }];
    const usable = env.isVideoModeUsable;
    env.isVideoModeUsable = (_settings, mode) => mode === 'local' || mode === 'fal';
    try {
      await start({ pool: falPool, limits: { ...LIMITS, spendCapUsd: 1.5 } });
      // The run's start-time price for the route: a default-length cutaway.
      expect(theRun().pricing).toEqual({ 'image:local:flux2-dev': 0, 'video:fal:': 0.8 });
      completeJob('job-1');
      completeJob('job-2');
      await settle();
    } finally {
      env.isVideoModeUsable = usable;
    }
    const clips = theRun().steps.filter((s) => s.kind === 'clip');
    // A's lip-sync take is charged 5.05s × $0.16; B's $0.80 would pass the cap.
    expect(clips.map((s) => [s.sceneId, s.costUsd])).toEqual([['mvs-a', 0.808]]);
    expect(theRun()).toMatchObject({ status: 'limit-reached', usage: { spentUsd: 0.808 }, stopReason: expect.stringMatching(/\$1\.5 cap/) });
    expect(dispatch.mock.calls.filter(([a]) => a.stepKind === 'clip').map(([a]) => a.scene.sceneId)).toEqual(['mvs-a']);
  });

  it('after a restart nothing dispatches until an explicit resume, which neither duplicates live jobs nor re-charges them', async () => {
    seedProject();
    await start();
    expect(dispatch).toHaveBeenCalledTimes(2);
    // Simulate a restart: the checkpoint names another process; a job finished meanwhile.
    store.get('mv-example').productionRuns[0].processId = 'proc-previous';
    completeJob('job-1');
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(theRun().steps.find((s) => s.jobId === 'job-1').status).toBe('completed');

    const resumed = await service.resumeProduction('mv-example', theRun().id);
    expect(resumed.run.interrupted).toBe(false);
    await settle();
    // job-2 is still queued, so only scene A's clip goes out.
    expect(dispatch.mock.calls.slice(2).map(([a]) => [a.stepKind, a.scene.sceneId])).toEqual([['clip', 'mvs-a']]);
    expect(theRun().usage.generations).toBe(3);
  });

  it('halts when the creative setup changes, and continues only when resume accepts the new basis', async () => {
    seedProject();
    await start();
    store.get('mv-example').concept = { style: 'pastel' };
    completeJob('job-1');
    await settle();
    expect(theRun()).toMatchObject({ status: 'needs-replan' });
    const before = dispatch.mock.calls.length;

    await expect(service.resumeProduction('mv-example', theRun().id)).rejects.toMatchObject({ code: 'PRODUCTION_BASIS_CHANGED' });
    await service.resumeProduction('mv-example', theRun().id, { acceptBasis: true });
    await settle();
    expect(theRun()).toMatchObject({ status: 'running', basis: { capturedAt: expect.any(String) } });
    expect(dispatch.mock.calls.length).toBe(before + 1);
  });

  it('dispatches the review\'s revised sections server-side, tagged with its revision', async () => {
    seedProject();
    await start();
    completeJob('job-1'); completeJob('job-2');
    await settle();
    completeJob('job-3'); completeJob('job-4');
    await settle();
    const reviewRun = store.get('mv-example').autoReviews[0];
    store.get('mv-example').scenes[0].videoHistoryId = null;
    musicVideoEvents.emit('auto-review', { projectId: 'mv-example', run: { ...reviewRun }, action: { type: 'generate', revisionId: 'mvrv-example', sections: [{ sceneId: 'mvs-a', kind: 'video' }] } });
    await settle();
    const last = dispatch.mock.calls.at(-1)[0];
    expect(last).toMatchObject({ stepKind: 'clip', tag: { revisionId: 'mvrv-example', sceneId: 'mvs-a' } });
  });
});
