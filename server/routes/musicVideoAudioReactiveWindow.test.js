/**
 * Audio-reactive scene clips record their song window in history and job
 * execution provenance (#15971), matching the supplied-audio shape.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-audio-reactive-window-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({ videoGen: {}, imageGen: { local: { pythonPath: '/usr/bin/python3' } } })) }));
vi.mock('../services/tracks/index.js', () => ({ getTrack: vi.fn() }));
vi.mock('../services/loras.js', () => ({
  listLoras: vi.fn(async () => [{
    filename: 'audio-reactive-ltx23.safetensors',
    name: 'Audio Reactive',
    loraCompatKey: 'ltx-video',
  }]),
}));
vi.mock('../lib/mediaModels.js', async (importOriginal) => {
  const actual = await importOriginal();
  const model = {
    id: 'ltx23-example',
    name: 'LTX 2.3 Example',
    runtime: 'ltx2',
    supportedModes: ['text', 'image', 'fflf', 'a2v'],
    audioInput: true,
    maxNumFrames: 1441,
    frameStride: 8,
    fpsOptions: [24],
    defaultWidth: 768,
    defaultHeight: 512,
  };
  const mlxModel = {
    id: 'ltx23-mlx-example',
    name: 'LTX 2.3 MLX Example',
    runtime: 'mlx_video',
    supportedModes: ['text', 'image', 'fflf', 'a2v'],
    audioInput: true,
    maxNumFrames: 1441,
    frameStride: 8,
    fpsOptions: [24],
    defaultWidth: 768,
    defaultHeight: 512,
  };
  return {
    ...actual,
    getVideoModels: vi.fn(() => [model, mlxModel]),
  };
});
vi.mock('../services/videoGen/local.js', async (importOriginal) => {
  const actual = await importOriginal();
  const model = {
    id: 'ltx23-example',
    name: 'LTX 2.3 Example',
    runtime: 'ltx2',
    supportedModes: ['text', 'image', 'fflf', 'a2v'],
    audioInput: true,
    hardwareCompatibility: { compatible: true },
  };
  const mlxModel = {
    id: 'ltx23-mlx-example',
    name: 'LTX 2.3 MLX Example',
    runtime: 'mlx_video',
    supportedModes: ['text', 'image', 'fflf', 'a2v'],
    audioInput: true,
    maxNumFrames: 1441,
    frameStride: 8,
    fpsOptions: [24],
    hardwareCompatibility: { compatible: true },
  };
  return {
    ...actual,
    getPythonPath: vi.fn(async () => '/usr/bin/python3'),
    listVideoModels: vi.fn(() => [model, mlxModel]),
    defaultVideoModelId: vi.fn(() => model.id),
    resolveByovRuntimeLoraCapable: vi.fn(async () => true),
    loadHistory: vi.fn(async () => []),
  };
});

const jobStore = vi.hoisted(() => new Map());
vi.mock('../services/mediaJobQueue/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enqueueJob: vi.fn(async ({ kind, params }) => {
      const job = {
        id: `job-${jobStore.size + 1}`,
        kind,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        params,
      };
      jobStore.set(job.id, job);
      return { jobId: job.id, position: 1, status: 'queued' };
    }),
    getJob: vi.fn((id) => jobStore.get(id) || null),
  };
});
vi.mock('../services/federatedMedia/sourceAudio.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    prepareSourceAudioWindow: vi.fn(async ({ project, scene, numFrames, fps }) => {
      const { captureMusicVideoEvidence } = await import('../lib/musicVideoDependencies.js');
      const startSample = Math.round(scene.startSec * 48000);
      const sampleCount = Math.round(((numFrames - 1) / fps) * 48000);
      return {
        audioFilePath: join(ROOT(), 'uploads', 'mv-source-audio-00000000-0000-0000-0000-000000000001.wav'),
        audioDependencies: captureMusicVideoEvidence(project, { sceneIds: [], composition: false }),
        songInterval: { startSec: scene.startSec, endSec: scene.endSec },
        audioConditioning: {
          sourceSha256: songSha256,
          clipSha256: 'b'.repeat(64),
          sampleRate: 48000,
          channels: 2,
          startSample,
          endSample: startSample + sampleCount,
          sampleCount,
        },
      };
    }),
  };
});

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const { default: mediaJobsRoutes } = await import('./mediaJobs.js');
const projects = await import('../services/musicVideo/projects.js');
const { getTrack } = await import('../services/tracks/index.js');
const { PATHS } = await import('../lib/paths.js');
const { videoExecutionSchema } = await import('../services/mediaJobQueue/videoExecution.js');
const { buildLocalVideoJobRecord } = await import('../services/videoGen/generateVideo.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use('/api/media-jobs', mediaJobsRoutes);
app.use(errorMiddleware);

let project;
let songSha256;

beforeEach(async () => {
  jobStore.clear();
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  mkdirSync(PATHS.music, { recursive: true });
  mkdirSync(PATHS.images, { recursive: true });
  mkdirSync(PATHS.uploads, { recursive: true });
  const songBytes = Buffer.from('fake-song-bytes-for-audio-reactive-window-test');
  songSha256 = createHash('sha256').update(songBytes).digest('hex');
  writeFileSync(join(PATHS.music, 'song.wav'), songBytes);
  writeFileSync(join(PATHS.images, 'frame-1.png'), Buffer.from('png'));
  getTrack.mockReset();
  getTrack.mockResolvedValue({ id: 'trk-1', audioFilename: 'song.wav' });

  project = await projects.createProject({ name: 'Reactive Window', trackId: 'trk-1' });
  await projects.updateProject(project.id, {
    scenes: [{
      sceneId: 'scene-2',
      order: 0,
      startSec: 18.5,
      endSec: 23.5,
      prompt: 'neon rain over wet pavement',
      referenceImageId: 'frame-1.png',
    }],
  });
});

afterAll(cleanupTempDataRoots);

describe('audio-reactive scene clip song window (#15971)', () => {
  it('records the song window in history and GET /api/media-jobs/:id without altering supplied-audio', async () => {
    const reactiveRes = await request(app)
      .post(`/api/music-video/${project.id}/scenes/scene-2/clip`)
      .send({
        target: {
          backend: 'local',
          modelId: 'ltx23-example',
          generationMode: 'audioReactive',
          numFrames: 121,
        },
      });
    expect(reactiveRes.status).toBe(200);
    const reactiveJob = jobStore.get(reactiveRes.body.jobId);
    const expectedWindow = {
      sourceSha256: songSha256,
      clipSha256: songSha256,
      sampleRate: 48000,
      channels: 2,
      startSample: Math.round(18.5 * 48000),
      endSample: Math.round(18.5 * 48000) + Math.round(((121 - 1) / 24) * 48000),
      sampleCount: Math.round(((121 - 1) / 24) * 48000),
    };
    expect(reactiveJob.params.audioConditioning).toEqual(expectedWindow);

    // History record carries the same audioConditioning window.
    const historyRecord = buildLocalVideoJobRecord({
      jobId: reactiveJob.id,
      batch: null,
      batchSize: 1,
      prompt: reactiveJob.params.prompt,
      negativePrompt: '',
      modelId: reactiveJob.params.modelId,
      model: { id: reactiveJob.params.modelId, name: 'LTX 2.3 Example' },
      actualSeed: 42,
      w: reactiveJob.params.width,
      h: reactiveJob.params.height,
      parsedNumFrames: reactiveJob.params.numFrames,
      parsedFps: reactiveJob.params.fps ?? 24,
      actualSteps: reactiveJob.params.steps ?? 20,
      actualGuidance: reactiveJob.params.guidanceScale,
      actualStage2Steps: null,
      tiling: reactiveJob.params.tiling,
      disableAudio: reactiveJob.params.disableAudio,
      sourceAudioProvenance: reactiveJob.params.audioConditioning,
      resolvedTextEncoder: null,
      filename: `${reactiveJob.id}.mp4`,
      createdAt: new Date().toISOString(),
      mode: reactiveJob.params.mode,
      hasMultiKeyframes: false,
      sourceImagePath: reactiveJob.params.sourceImagePath,
      effectiveReferenceMode: 'anchor',
      actualImageStrength: null,
      resolvedContinuation: null,
      resolvedSourceImage: reactiveJob.params.sourceImagePath,
      resolvedLastImage: null,
      resolvedKeyframes: null,
      extendFromVideoPath: null,
      audioFilePath: reactiveJob.params.audioFilePath,
      resolvedIcReferencePaths: null,
      visualConditioning: null,
      t2vTwoStage: null,
      speedProfile: null,
      draftDecoder: null,
      a2vLoraStageStrengths: null,
      resolvedLoras: [],
      streamingMode: null,
      actualIcStrength: null,
      actualIcAttentionStrength: null,
      icSkipStage2: false,
      icReferencePaths: null,
      referenceImagePaths: null,
      referenceVideoPaths: null,
      referenceAudioPaths: null,
      loraLicenses: {},
      addedTriggerWords: [],
      renderPrompt: reactiveJob.params.prompt,
      sentRecord: {},
      hidden: false,
    });
    expect(historyRecord.audioConditioning).toEqual(expectedWindow);

    // Job execution receipt exposes the same window on GET /api/media-jobs/:id.
    reactiveJob.videoExecution = videoExecutionSchema.parse({
      version: 1,
      preparedAt: new Date().toISOString(),
      seed: 42,
      parameters: historyRecord,
    });
    const jobRes = await request(app).get(`/api/media-jobs/${reactiveJob.id}`);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.videoExecution.parameters.audioConditioning).toEqual(expectedWindow);

    // Supplied-audio path still records its sliced clipSha256 and shotInstruction unchanged.
    const suppliedRes = await request(app)
      .post(`/api/music-video/${project.id}/scenes/scene-2/clip`)
      .send({
        card: { songAudio: true },
        target: {
          backend: 'local',
          modelId: 'ltx23-example',
        },
      });
    expect(suppliedRes.status).toBe(200);
    const suppliedJob = jobStore.get(suppliedRes.body.jobId);
    expect(suppliedJob.params.audioConditioning).toEqual({
      sourceSha256: songSha256,
      clipSha256: 'b'.repeat(64),
      sampleRate: 48000,
      channels: 2,
      startSample: Math.round(18.5 * 48000),
      endSample: Math.round(18.5 * 48000) + Math.round(((121 - 1) / 24) * 48000),
      sampleCount: Math.round(((121 - 1) / 24) * 48000),
    });
    expect(suppliedJob.params.shotInstruction).toMatchObject({
      version: 1,
      shotMode: 'cutaway',
      songInterval: { startSec: 18.5, endSec: 23.5 },
    });
  });
});
