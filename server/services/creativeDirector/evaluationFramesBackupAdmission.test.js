/** Creative Director evaluation frames over real files, with the scene row
 * write held at its commit seam. A backup cut must never land between writing
 * `${jobId}-fN.jpg` and the scene row that names those frames (#9982). */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-cd-frames-'),
}));

// In-memory project rows standing in for the store. Every scene write awaits
// `beforeRowWrite`, so a test can hold the commit after the frames landed.
let project;
let beforeRowWrite = async () => {};
vi.mock('./local.js', () => ({
  getProject: async () => structuredClone(project),
  updateProject: async (_id, patch) => { project = { ...project, ...patch }; },
  updateScene: async (_id, sceneId, patch) => {
    await beforeRowWrite();
    const scenes = project.treatment.scenes.map(scene => (scene.sceneId === sceneId ? { ...scene, ...patch } : scene));
    project = { ...project, treatment: { ...project.treatment, scenes } };
  },
  updateRun: async () => ({}),
  recordRun: async () => ({}),
}));

// The sampler writes its frames with ffmpeg; this one writes a placeholder file.
let framesDir;
vi.mock('../videoGen/local.js', () => ({
  extractLastFrame: async () => null,
  sampleEvaluationFrames: async (jobId) => {
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(framesDir, `${jobId}-f1.jpg`), 'synthetic frame');
    return [`${jobId}-f1.jpg`];
  },
}));
vi.mock('../mediaJobQueue/index.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    mediaJobEvents: new EventEmitter(),
    enqueueJob: async () => ({ jobId: '00000000-0000-4000-8000-000000000001', position: 1 }),
    getJob: () => null,
    listJobs: () => [],
  };
});
vi.mock('../settings.js', () => ({
  getSettings: async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } }),
  getSettingsWithStatus: async () => ({ corrupt: false, settings: { imageGen: { local: { pythonPath: '/usr/bin/python3' } } } }),
}));
vi.mock('../instanceIdentity.js', () => ({ getInstanceId: async () => 'example-owner' }));
vi.mock('./sceneEvaluator.js', () => ({ dispatchSceneEvaluation: vi.fn(async () => {}) }));
vi.mock('./agentBridge.js', () => ({ enqueueTreatmentTask: async () => {} }));
vi.mock('./planAdvance.js', () => ({ advanceAfterPlanStepSettled: async () => {} }));
vi.mock('./stitchRunner.js', () => ({ runStitch: async () => {} }));

const { PATHS } = await import('../../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { mediaJobEvents } = await import('../mediaJobQueue/index.js');
const { dispatchSceneEvaluation } = await import('./sceneEvaluator.js');
const { runSceneRender } = await import('./sceneRunner.js');
const { advanceAfterSceneSettled } = await import('./completionHook.js');

const JOB = '00000000-0000-4000-8000-000000000001';
const FRAME = `${JOB}-f1.jpg`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const holdRowWrite = () => {
  const reached = deferred();
  const commit = deferred();
  beforeRowWrite = async () => { reached.resolve(); await commit.promise; };
  return { reached: reached.promise, commit: commit.resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
// What a snapshot holds: the frames copied and the frames the scene row names.
const capture = async () => ({
  files: await readdir(framesDir).catch(() => []),
  row: project.treatment.scenes[0].evaluationFrames,
});
const makeProject = scene => ({
  id: 'project-1', status: 'rendering', aspectRatio: '16:9', quality: 'standard', modelId: 'example-model', runs: [],
  treatment: { scenes: [{ sceneId: 'scene-1', order: 0, prompt: 'an example scene', durationSeconds: 4, ...scene }] },
});

// Both writers of evaluation frames: the render's completion listener, and
// the resume pass that re-samples frames missing from disk in place.
const WRITERS = [
  {
    name: 'render completion',
    project: () => makeProject({ status: 'pending' }),
    start: async () => {
      await runSceneRender(project, project.treatment.scenes[0]);
      return () => mediaJobEvents.emit('completed', { id: JOB });
    },
  },
  {
    name: 'resume re-sample',
    project: () => makeProject({ status: 'evaluating', renderedJobId: JOB, evaluationFrames: ['missing-frame.jpg'] }),
    start: async () => () => { void advanceAfterSceneSettled('project-1'); },
  },
];

afterAll(cleanupTempDataRoots);
beforeEach(async () => {
  beforeRowWrite = async () => {};
  framesDir = PATHS.videoThumbnails;
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.videos, `${JOB}.mp4`), 'synthetic clip');
  mediaJobEvents.removeAllListeners();
  vi.mocked(dispatchSceneEvaluation).mockClear();
});

describe.each(WRITERS)('$name evaluation frames', ({ project: fixture, start }) => {
  beforeEach(() => { project = fixture(); });

  it('drains a frame write already in progress through the scene row that names it', async () => {
    const write = await start();
    const hold = holdRowWrite();
    write();
    await hold.reached;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    await settle();
    expect(cutReady).toBe(false);
    hold.commit();
    const release = await cut;
    expect(await capture()).toEqual({ files: [FRAME], row: [FRAME] });
    release();
    await vi.waitFor(() => expect(dispatchSceneEvaluation).toHaveBeenCalledTimes(1));
  });

  it('writes no frame while a cut is open, then publishes frames and row together', async () => {
    const write = await start();
    const rowBefore = project.treatment.scenes[0].evaluationFrames;
    const release = await acquireBackupSnapshotCut();
    write();
    for (let i = 0; i < 5; i += 1) await settle();
    expect(await capture()).toEqual({ files: [], row: rowBefore });
    release();
    await vi.waitFor(async () => expect(await capture()).toEqual({ files: [FRAME], row: [FRAME] }));
  });
});
