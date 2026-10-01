/**
 * Music Video production run (#9066) — orchestration contract with injected
 * queue events. The project store is an in-memory double with the real
 * store's serialized read-modify-write; the queue, generation lanes and
 * review service are doubles; the checkpoint (production.js) and the pool
 * rules (productionPool.js) are real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';

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
const startCastAndSets = vi.fn();
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
    startCastAndSets,
    autoReview: async () => autoReview,
    resolveAuthoring: async (input) => {
      if (!input?.providerId || !input?.model) throw Object.assign(new Error('Select an authoring model'), { code: 'PRODUCTION_AUTHORING_REQUIRED' });
      return { ...input, costUsd: 0 };
    },
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

  it('in a composition document, skips frames for card scenes and clips for still/card scenes', async () => {
    seedProject({
      composition: { mode: 'document' },
      scenes: [
        { sceneId: 'mvs-a', label: 'A', framePrompt: 'a lighthouse', prompt: 'waves roll', startSec: 0, endSec: 4, takes: [] },
        { sceneId: 'mvs-card', label: 'Card', visualLayer: 'card', startSec: 4, endSec: 6, takes: [] },
        { sceneId: 'mvs-still', label: 'Still', visualLayer: 'still', framePrompt: 'a harbor', referenceImageId: 'harbor.png', startSec: 6, endSec: 8, takes: [] },
      ],
    });
    await start();
    // Only the footage scene needs a frame; the card needs none and the still already has one.
    expect(dispatch.mock.calls.map(([a]) => [a.stepKind, a.scene.sceneId])).toEqual([['frame', 'mvs-a']]);
    completeJob('job-1');
    await settle();
    // Only the footage scene needs a clip — the document draws the still and the card itself.
    expect(dispatch.mock.calls.slice(1).map(([a]) => [a.stepKind, a.scene.sceneId])).toEqual([['clip', 'mvs-a']]);
  });

  it('plans an empty board once, with the directive, before generating', async () => {
    seedProject({ scenes: [], castAndSets: { status: 'skipped' } });
    planProject.mockImplementation(async () => {
      store.get('mv-example').scenes = [{ sceneId: 'mvs-p', framePrompt: 'x', prompt: 'y', startSec: 0, endSec: 4, takes: [] }];
      return { scenesAdded: 1 };
    });
    await start();
    expect(planProject).toHaveBeenCalledWith('mv-example', { seedPrompts: true, directive: 'moody, slow' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('has the autopilot cut on the song unless the director chose how it cuts (#9290)', async () => {
    seedProject({ scenes: [], castAndSets: { status: 'skipped' } });
    planProject.mockResolvedValue({ scenesAdded: 0 });
    await start();
    expect(store.get('mv-example').composition.cutting).toBe('intercut');

    seedProject({ scenes: [], castAndSets: { status: 'skipped' }, composition: { mode: 'composed', cutting: 'scene', textCues: [] } });
    await start();
    expect(store.get('mv-example').composition.cutting).toBe('scene');
  });

  it('runs the Cast & Sets check-in before the plan and waits for the director in review mode', async () => {
    seedProject({ scenes: [], visualSpec: { references: [] } });
    startCastAndSets.mockImplementation(async (projectId, { productionRunId }) => {
      store.get(projectId).castAndSets = { status: 'directing', productionRunId };
      return {};
    });
    planProject.mockImplementation(async () => {
      store.get('mv-example').scenes = [{ sceneId: 'mvs-p', framePrompt: 'x', prompt: 'y', startSec: 0, endSec: 4, takes: [] }];
      return { scenesAdded: 1 };
    });
    await start();
    expect(startCastAndSets).toHaveBeenCalledTimes(1);
    expect(startCastAndSets.mock.calls[0][1]).toMatchObject({ productionRunId: theRun().id });
    expect(planProject).not.toHaveBeenCalled();

    // The sheet is waiting for its check-in: the run waits, it neither plans nor halts.
    store.get('mv-example').castAndSets.status = 'review';
    musicVideoEvents.emit('cast-and-sets', { projectId: 'mv-example', stage: { status: 'review' } });
    await settle();
    expect(planProject).not.toHaveBeenCalled();
    expect(theRun()).toMatchObject({ status: 'running', planned: false, castAndSetsStarted: true });

    // Approval writes new references (a creative-setup change) and re-bases the run in the same write.
    const { rebaseProductionAfterCheckin } = await import('./production.js');
    const project = store.get('mv-example');
    project.castAndSets.status = 'approved';
    project.visualSpec = { references: [{ id: 'mvr-cs-character', imageId: 'sheet.png', role: 'character', condition: true }] };
    store.set('mv-example', rebaseProductionAfterCheckin(project).project);
    musicVideoEvents.emit('cast-and-sets', { projectId: 'mv-example', stage: { status: 'approved' } });
    await settle();
    expect(planProject).toHaveBeenCalledTimes(1);
    expect(theRun().status).toBe('running');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('halts blocked when the Cast & Sets check-in fails, and never plans past it', async () => {
    seedProject({ scenes: [], castAndSets: { status: 'failed', stopReason: 'no image backend' } });
    await start();
    expect(startCastAndSets).not.toHaveBeenCalled();
    expect(planProject).not.toHaveBeenCalled();
    expect(theRun()).toMatchObject({ status: 'blocked' });
    expect(theRun().stopReason).toMatch(/no image backend/);
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

  it('does not start a code-first document run through legacy frame and clip lanes', async () => {
    seedProject({ composition: { mode: 'document' }, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } });
    await expect(service.startProduction('mv-example', { pool: POOL, limits: LIMITS }))
      .rejects.toMatchObject({ code: 'PRODUCTION_AUTHORING_REQUIRED' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses a generation if the director changes to zero code-first allowance during provider preparation', async () => {
    seedProject();
    let release;
    const prepared = new Promise((resolve) => { release = resolve; });
    dispatch.mockImplementationOnce(async (args) => {
      await prepared;
      await service.assertProductionSubmission('mv-example', args.tag.productionRunId, args.tag.productionStepKey,
        { sceneId: args.tag.sceneId, kind: 'image' });
      return enqueueing(args);
    });
    await service.startProduction('mv-example', { pool: POOL, limits: LIMITS });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(theRun().steps[0].status).toBe('reserved');
    store.get('mv-example').productionPolicy = { strategy: 'code-first', maxGeneratedVideoPercent: 0 };
    release();
    await settle();
    expect(jobs).toHaveLength(0);
    expect(theRun()).toMatchObject({ status: 'blocked', usage: { generations: 0 } });
    expect(theRun().steps[0]).toMatchObject({ status: 'refused', error: expect.stringMatching(/policy|plan/i) });
    await expect(service.resumeProduction('mv-example', theRun().id, { acceptBasis: true }))
      .rejects.toMatchObject({ code: 'PRODUCTION_AUTHORING_REQUIRED' });
  });

  it('keeps pre-upgrade legacy run checksums valid after adding the policy-aware basis', async () => {
    seedProject();
    await start();
    const stored = store.get('mv-example');
    // Reconstruct the version-one persisted basis from its old field contract.
    const pick = (value) => value ?? null;
    const oldRevision = canonicalSnapshotChecksum({
      concept: pick(stored.concept), visualSpec: pick(stored.visualSpec),
      ...(stored.styleReferences?.length ? { styleReferences: stored.styleReferences } : {}),
      brief: pick(stored.treatment?.brief), automation: pick(stored.automation),
      audio: { trackId: pick(stored.trackId), uploadedAudioFilename: pick(stored.uploadedAudioFilename),
        sections: pick(stored.audioAnalysis?.sections), durationSec: pick(stored.audioAnalysis?.durationSec) },
      pacing: pick(stored.pacing), composition: pick(stored.composition?.mode),
    });
    stored.productionRuns[0].basis = { revision: oldRevision, capturedAt: stored.productionRuns[0].createdAt };
    completeJob('job-1');
    await settle();
    expect(theRun().status).toBe('running');
    expect(theRun().basis).not.toHaveProperty('version');
  });
});

// The real state machine/pool run against controlled authors and encoders;
// collaborators must honor the same publication/submission guards as providers.
const AUTHORING = { providerId: 'local-fixture', model: 'fixture-model' };
const authorProvider = { id: AUTHORING.providerId, type: 'api', endpoint: 'http://localhost:11434' };
const storeMutation = async (transform) => (await import('./projects.js')).mutateProjectRecord('mv-example', transform);
function seedCodeFirst({ scenes, directions, percent = 0, ...patch } = {}) {
  return seedProject({ composition: { mode: 'document' },
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: percent },
    scenes: scenes || [{ sceneId: 'mvs-code', label: 'Code', startSec: 0, endSec: 8 }],
    treatment: { shotDirections: directions || [{ sceneId: 'mvs-code', medium: 'procedural', mediumRationale: 'Typography' }] }, ...patch,
  });
}
function documentDoubles() {
  let version = 0;
  const author = vi.fn(async (_id, input) => {
    await input.beforeSubmit({ provider: authorProvider, model: AUTHORING.model });
    return storeMutation((project) => {
      input.verifyCurrent(project);
      const document = { directory: `music-video/mv-example/composition/doc-${version += 1}`, source: { kind: 'generated' } };
      return { project: { ...project, composition: { ...project.composition, documentDraft: document } }, document };
    });
  });
  const regenerate = vi.fn(async (id, _sectionId, input) => author(id, input));
  const accept = vi.fn(async (_id, directory, options) => storeMutation((project) => {
    options.verifyCurrent(project);
    if (project.composition.documentDraft?.directory !== directory) throw new Error('stale candidate');
    const { documentDraft, ...composition } = project.composition;
    return { project: { ...project, composition: { ...composition, document: documentDraft } }, document: documentDraft };
  }));
  const documents = { generateMixedMediaDocument: author, regenerateMixedMediaSection: regenerate, acceptMixedMediaDocument: accept,
    readMixedMediaCandidate: async () => ({ stale: false, source: current().composition.documentDraft || current().composition.document, sections: [
      { id: 'verse', startSec: 0, endSec: 4 }, { id: 'hook', startSec: 4, endSec: 8 },
    ] }),
  };
  const render = vi.fn(async (_id, options) => { options.verifyCurrent(current()); return { jobId: 'final-render' }; });
  const cancelRender = vi.fn();
  service.__setProductionDepsForTests({ loadEnv: async () => env, dispatch, queue: async () => queue,
    autoReview: async () => autoReview, documents: async () => documents,
    render: async () => ({ renderMusicVideo: render, cancelRender }),
    resolveAuthoring: async (input) => {
      if (!input?.providerId) throw Object.assign(new Error('Select an authoring model'), { code: 'PRODUCTION_AUTHORING_REQUIRED' });
      return { ...input, costUsd: 0 };
    },
  });
  return { author, regenerate, accept, render, cancelRender };
}
function passOwnedReview() {
  const project = store.get('mv-example');
  const review = project.autoReviews[0];
  review.status = 'passed';
  musicVideoEvents.emit('auto-review', { projectId: project.id, run: clone(review), action: { type: 'idle' } });
}
function failOwnedReview(atSec = 6) {
  const review = store.get('mv-example').autoReviews[0];
  Object.assign(review, { startSec: 0, attempts: [{ n: 1, review: { verdict: 'revise', findings: [{ severity: 'blocking', atSec, note: 'Type transition jumps' }] } }] });
  musicVideoEvents.emit('auto-review', { projectId: 'mv-example', run: clone(review), action: { type: 'revise-document' } });
}

describe('code-first production execution (#9301)', () => {
  it('authors a code-only plan with no media routes/jobs and completes only after its reviewed final render', async () => {
    seedCodeFirst(); const { author, render } = documentDoubles();
    await start({ pool: [], authoring: AUTHORING });
    expect(jobs).toEqual([]); expect(dispatch).not.toHaveBeenCalled(); expect(author).toHaveBeenCalledOnce();
    expect(theRun()).toMatchObject({ usage: { generations: 1, spentUsd: 0 }, documentCheckpoint: { directory: current().composition.document.directory } });
    expect(startAutoReview.mock.calls[0][1]).toMatchObject({ documentRevisions: true, startSec: 0, endSec: 8 });
    passOwnedReview(); await settle();
    expect(render).toHaveBeenCalledOnce(); expect(theRun().status).toBe('running');
    musicVideoEvents.emit('document-render', { projectId: 'mv-example', runId: theRun().id, jobId: 'final-render', attemptId: theRun().finalRender.attemptId, status: 'completed' });
    await settle(); expect(theRun().status).toBe('completed');
  });

  it('prepares only missing selected still/footage assets and reuses imported takes', async () => {
    seedCodeFirst({ percent: 50,
      scenes: [{ sceneId: 'code', startSec: 0, endSec: 1 }, { sceneId: 'still', startSec: 1, endSec: 2, framePrompt: 'still' },
        { sceneId: 'imported', startSec: 2, endSec: 4, videoHistoryId: 'imported-take' },
        { sceneId: 'generated', startSec: 4, endSec: 8, framePrompt: 'frame', prompt: 'motion' }],
      directions: ['procedural', 'still', 'existing-footage', 'generated-footage'].map((medium, index) => ({ sceneId: ['code', 'still', 'imported', 'generated'][index], medium, mediumRationale: 'Selected look' })),
    });
    const { author } = documentDoubles();
    await start({ pool: [POOL[0], POOL[2]], authoring: AUTHORING });
    expect(dispatch.mock.calls.map(([args]) => [args.stepKind, args.scene.sceneId])).toEqual([['frame', 'still'], ['frame', 'generated']]);
    completeJob('job-1'); completeJob('job-2'); await settle();
    expect(dispatch.mock.calls.at(-1)[0]).toMatchObject({ stepKind: 'clip', scene: { sceneId: 'generated' } });
    expect(theRun().steps.at(-1).editInterval).toEqual({ startSec: 4, endSec: 8 });
    completeJob('job-3'); await settle();
    expect(author).toHaveBeenCalledOnce(); expect(current().scenes[2].videoHistoryId).toBe('imported-take');
    expect(theRun().usage.generations).toBe(4);
  });

  it('refuses over-allowance and missing-import plans before any provider submission', async () => {
    seedCodeFirst({ directions: [{ sceneId: 'mvs-code', medium: 'generated-footage', mediumRationale: 'Motion' }] });
    const { author } = documentDoubles();
    await expect(start({ pool: [], authoring: AUTHORING })).rejects.toMatchObject({ code: 'PRODUCTION_MEDIUM_CONFLICT' });
    expect(dispatch).not.toHaveBeenCalled(); expect(author).not.toHaveBeenCalled();
    seedCodeFirst({ directions: [{ sceneId: 'mvs-code', medium: 'existing-footage', mediumRationale: 'Imported' }] });
    await expect(start({ pool: POOL, authoring: AUTHORING })).rejects.toMatchObject({ code: 'PRODUCTION_MEDIUM_CONFLICT' });
  });

  it('refuses an approved performance disguised by a legacy card layer before any provider call', async () => {
    seedCodeFirst({ percent: 100,
      scenes: [{ sceneId: 'mvs-code', shotMode: 'performance', visualLayer: 'card', startSec: 0, endSec: 8 }],
      directions: [{ sceneId: 'mvs-code', mode: 'performance', medium: 'generated-footage', mediumRationale: 'Sung performance' }],
    });
    const { author } = documentDoubles();
    await expect(start({ pool: POOL, authoring: AUTHORING })).rejects.toMatchObject({ code: 'PRODUCTION_MEDIUM_CONFLICT' });
    expect(dispatch).not.toHaveBeenCalled(); expect(author).not.toHaveBeenCalled();
  });

  it('revises only the failed code section while retaining selected assets and a zero video allowance', async () => {
    seedCodeFirst(); const { regenerate } = documentDoubles();
    await start({ pool: [], authoring: AUTHORING });
    failOwnedReview(); await settle();
    expect(regenerate).toHaveBeenCalledOnce(); expect(regenerate.mock.calls[0][1]).toBe('hook');
    expect(theRun().usage.generations).toBe(2); expect(jobs).toEqual([]);
    expect(current().productionPolicy.maxGeneratedVideoPercent).toBe(0);
    expect(current().autoReviews[0].attempts.at(-1)).toMatchObject({ n: 2, excerptId: null });
  });

  it('halts a review-driven code revision before a provider call past the generation cap', async () => {
    seedCodeFirst(); const { author } = documentDoubles();
    await start({ pool: [], authoring: AUTHORING, limits: { maxGenerations: 1, maxReviewAttempts: 2 } });
    let submitted = 0;
    author.mockImplementationOnce(async (_id, input) => { await input.beforeSubmit({ provider: authorProvider, model: AUTHORING.model }); submitted += 1; });
    failOwnedReview(); await settle();
    expect(submitted).toBe(0); expect(theRun().usage.generations).toBe(1); expect(theRun().status).toBe('limit-reached');
  });

  it('refuses an unpriced author at the actual submission boundary under a dollar cap', async () => {
    seedCodeFirst(); const { author } = documentDoubles();
    let submitted = 0;
    author.mockImplementationOnce(async (_id, input) => {
      await input.beforeSubmit({ provider: { ...authorProvider, endpoint: 'https://api.example.com/v1' }, model: AUTHORING.model });
      submitted += 1;
    });
    await start({ pool: [], authoring: AUTHORING, limits: { ...LIMITS, spendCapUsd: 1 } });
    expect(submitted).toBe(0); expect(theRun()).toMatchObject({ status: 'blocked', usage: { generations: 0, spentUsd: 0 } });
    expect(theRun().stopReason).toMatch(/no known price/);
  });

  it('does not accept a completed revision after its owning review stops', async () => {
    seedCodeFirst(); const { accept } = documentDoubles();
    await start({ pool: [], authoring: AUTHORING });
    const selected = current().composition.document.directory;
    const normal = accept.getMockImplementation();
    accept.mockImplementationOnce(async (...args) => {
      store.get('mv-example').autoReviews[0].status = 'stopped';
      return normal(...args);
    });
    failOwnedReview(); await settle();
    expect(current().composition.document.directory).toBe(selected);
    expect(current().composition.documentDraft.directory).not.toBe(selected);
    expect(theRun().usage.generations).toBe(2);
    expect(theRun().status).toBe('blocked');
  });

  it('does not submit late authoring after cancellation during preparation', async () => {
    seedCodeFirst(); const { author } = documentDoubles();
    let release; const waiting = new Promise((resolve) => { release = resolve; });
    const normal = author.getMockImplementation();
    author.mockImplementationOnce(async (id, input) => { await waiting; return normal(id, input); });
    await service.startProduction('mv-example', { pool: [], authoring: AUTHORING, limits: LIMITS });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.cancelProduction('mv-example', theRun().id);
    release(); await settle();
    expect(theRun().status).toBe('canceled'); expect(theRun().usage.generations).toBe(0);
    expect(current().composition.documentDraft).toBeUndefined();
  });

  it('drops a paid authoring result when the policy changes before publication', async () => {
    seedCodeFirst(); const { author } = documentDoubles();
    let release; const waiting = new Promise((resolve) => { release = resolve; });
    author.mockImplementationOnce(async (_id, input) => {
      await input.beforeSubmit({ provider: authorProvider, model: AUTHORING.model }); await waiting;
      await storeMutation((project) => { input.verifyCurrent(project); return { project }; });
    });
    await service.startProduction('mv-example', { pool: [], authoring: AUTHORING, limits: LIMITS });
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.get('mv-example').productionPolicy.maxGeneratedVideoPercent = 5;
    release(); await settle();
    expect(current().composition.document).toBeUndefined(); expect(theRun().usage.generations).toBe(1);
    expect(theRun().steps[0].status).toBe('failed');
  });

  it('retains a fast final-render terminal event when its queue link arrives later', async () => {
    seedCodeFirst(); const { render } = documentDoubles();
    render.mockImplementationOnce(async () => {
      musicVideoEvents.emit('document-render', { projectId: 'mv-example', runId: theRun().id, jobId: 'fast-render', attemptId: theRun().finalRender.attemptId, status: 'completed' });
      await new Promise((resolve) => setTimeout(resolve, 0)); return { jobId: 'fast-render' };
    });
    await start({ pool: [], authoring: AUTHORING }); passOwnedReview(); await settle();
    expect(theRun()).toMatchObject({ status: 'completed', finalRender: { status: 'completed', jobId: 'fast-render' } });
  });

  it('refuses a replaced selected document before final render', async () => {
    seedCodeFirst(); const { render } = documentDoubles();
    await start({ pool: [], authoring: AUTHORING });
    store.get('mv-example').composition.document.directory = 'music-video/mv-example/composition/doc-replaced';
    passOwnedReview(); await settle();
    expect(render).not.toHaveBeenCalled(); expect(theRun().status).toBe('needs-replan');
  });

  it('stops a pending final-render preparation before encoding', async () => {
    seedCodeFirst(); const { render } = documentDoubles();
    let release; const waiting = new Promise((resolve) => { release = resolve; });
    let encoded = 0;
    render.mockImplementationOnce(async (_id, options) => { await waiting; options.verifyCurrent(current()); encoded += 1; return { jobId: 'late-render' }; });
    await start({ pool: [], authoring: AUTHORING }); passOwnedReview();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.stopProduction('mv-example', theRun().id); release(); await settle();
    expect(encoded).toBe(0); expect(theRun().status).toBe('stopped');
  });
});

it('rechecks a generated shot and zero allowance after asynchronous provider preparation', async () => {
  seedCodeFirst({ percent: 100,
    scenes: [{ sceneId: 'mvs-a', startSec: 0, endSec: 8, referenceImageId: 'frame.png', prompt: 'move' }],
    directions: [{ sceneId: 'mvs-a', medium: 'generated-footage', mediumRationale: 'Selected exception' }],
  });
  documentDoubles();
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  dispatch.mockImplementationOnce(async (args) => {
    await waiting;
    await service.assertProductionSubmission('mv-example', args.tag.productionRunId, args.tag.productionStepKey, { sceneId: 'mvs-a', kind: 'video' });
    return enqueueing(args);
  });
  await service.startProduction('mv-example', { pool: [POOL[2]], authoring: AUTHORING, limits: LIMITS });
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.get('mv-example').productionPolicy.maxGeneratedVideoPercent = 0;
  release(); await settle();
  expect(jobs).toHaveLength(0); expect(theRun().usage.generations).toBe(0);
  expect(theRun().steps[0].status).toBe('refused');
});

it('charges a selected performance retry by its actual padded provider duration without adding edit share', async () => {
  seedCodeFirst({ percent: 100, videoSettings: { backend: 'fal', falModelId: 'minimax/h3-max/image-to-video' },
    audioAnalysis: { durationSec: 30, sections: [{ startSec: 0, endSec: 30 }] },
    scenes: [{ sceneId: 'performance', shotMode: 'performance', startSec: 0, endSec: 4, referenceImageId: 'frame.png', prompt: 'perform' }],
    directions: [{ sceneId: 'performance', medium: 'generated-footage', mediumRationale: 'Sung performance' }],
  });
  documentDoubles();
  const usable = env.isVideoModeUsable;
  env.isVideoModeUsable = (_settings, mode) => mode === 'fal';
  try {
    await start({ pool: [{ kind: 'video', mode: 'fal' }], authoring: AUTHORING, limits: { ...LIMITS, spendCapUsd: 1.7 } });
    const job = jobs[0]; job.status = 'failed'; mediaJobEvents.emit('failed', job); await settle();
    const clips = theRun().steps.filter((step) => step.kind === 'clip');
    expect(clips).toHaveLength(2);
    expect(clips.map((step) => step.costUsd)).toEqual([0.808, 0.808]);
    expect(clips.map((step) => step.editInterval)).toEqual([{ startSec: 0, endSec: 4 }, { startSec: 0, endSec: 4 }]);
    jobs[1].status = 'failed'; mediaJobEvents.emit('failed', jobs[1]); await settle();
    // Explicit resume resets slot failure count, but the paid retry budget stays spent.
    await service.resumeProduction('mv-example', theRun().id); await settle();
    expect(jobs).toHaveLength(2); expect(theRun()).toMatchObject({ status: 'limit-reached', usage: { generations: 2, spentUsd: 1.616 } });
  } finally { env.isVideoModeUsable = usable; }
});

it.each([1_000, 120_000])('keeps interrupted authoring charged at %i ms without a queue job and requires explicit resume', async (reservationAge) => {
  seedCodeFirst(); const { author } = documentDoubles();
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  author.mockImplementationOnce(async (_id, input) => {
    await input.beforeSubmit({ provider: authorProvider, model: AUTHORING.model }); await waiting;
    input.verifyCurrent(current());
  });
  await service.startProduction('mv-example', { pool: [], authoring: AUTHORING, limits: LIMITS });
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.get('mv-example').productionRuns[0].processId = 'previous-process';
  release(); await settle();
  expect(author).toHaveBeenCalledOnce(); expect(current().composition.document).toBeUndefined();
  expect(theRun().usage.generations).toBe(1);
  // Persisted submission intent after a crash is not refundable even past the queue lease.
  store.get('mv-example').productionRuns[0].steps[0].status = 'reserved';
  store.get('mv-example').productionRuns[0].steps[0].reservedAt = new Date(Date.now() - reservationAge).toISOString();
  await service.resumeProduction('mv-example', theRun().id); await settle();
  expect(author).toHaveBeenCalledTimes(2); expect(theRun().usage.generations).toBe(2);
});

it('ignores an earlier failed render attempt completion after explicit retry', async () => {
  seedCodeFirst(); documentDoubles();
  await start({ pool: [], authoring: AUTHORING }); passOwnedReview(); await settle();
  const oldAttempt = theRun().finalRender.attemptId;
  musicVideoEvents.emit('document-render', { projectId: 'mv-example', runId: theRun().id, jobId: 'final-render', attemptId: oldAttempt, status: 'failed', error: 'encoder failed' });
  await settle(); expect(theRun().status).toBe('blocked');
  await service.resumeProduction('mv-example', theRun().id); await settle();
  expect(theRun().finalRender.attemptId).not.toBe(oldAttempt);
  musicVideoEvents.emit('document-render', { projectId: 'mv-example', runId: theRun().id, jobId: 'final-render', attemptId: oldAttempt, status: 'completed' });
  await settle(); expect(theRun().status).toBe('running');
  expect(theRun().finalRender.status).toBe('queued');
});

it('requires reauthoring and a new review after an accepted policy/selected-asset change', async () => {
  seedCodeFirst(); const { author } = documentDoubles();
  await start({ pool: [], authoring: AUTHORING });
  store.get('mv-example').scenes[0].referenceImageId = 'new-selection.png';
  await settle(); expect(theRun().status).toBe('needs-replan');
  await service.resumeProduction('mv-example', theRun().id, { acceptBasis: true }); await settle();
  expect(author).toHaveBeenCalledTimes(2);
  expect(autoReview.cancelAutoReview).toHaveBeenCalledWith('mv-example', 'mvar-example');
  expect(theRun().documentCheckpoint.directory).toBe(current().composition.document.directory);
});
