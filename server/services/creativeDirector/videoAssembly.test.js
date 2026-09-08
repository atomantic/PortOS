import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ root: null, project: null, history: [], collection: [], tracks: [] }));
vi.mock('../../lib/fileUtils.js', async importOriginal => {
  const original = await importOriginal();
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  state.root = await mkdtemp(join(tmpdir(), 'video-assembly-test-'));
  return { ...original, PATHS: { ...original.PATHS, data: state.root, videos: join(state.root, 'videos'), music: join(state.root, 'music'), videoThumbnails: join(state.root, 'thumbnails') }, sleep: () => new Promise(resolve => setTimeout(resolve, 20)) };
});
vi.mock('./local.js', () => ({
  getProject: async () => structuredClone(state.project),
  mutateVideoProject: async (_id, mutate) => { const outcome = mutate(structuredClone(state.project)); if (!outcome.skipPersist) state.project = outcome.project; return outcome; },
}));
vi.mock('../videoGen/local.js', () => ({ loadHistory: async () => state.history, mutateVideoHistory: async mutate => { state.history = mutate(state.history); return state.history; } }));
vi.mock('../instances.js', () => ({ getInstanceId: async () => 'example-owner' }));
vi.mock('./videoSources.js', () => ({ assertVideoSourcesAvailable: async () => {} }));
vi.mock('../mediaCollections.js', () => ({ addItem: async (_id, item) => { state.collection.push(item); } }));
vi.mock('../tracks/index.js', () => ({ getTrack: async id => state.tracks.find(track => track.id === id) }));
// Keep library lookup inside this test's music directory while exercising the real mux.
vi.mock('../pipeline/musicLibrary.js', () => ({ statMusicTrack: async filename => ({ filename }) }));
import { findFfmpeg, findFfprobe, hasAudioStream } from '../../lib/ffmpeg.js';
import { videoConfigurationRevision } from './videoExecution.js';
import { videoReviewStages, applyVideoReviewAction } from '../../lib/creativeDirectorVideoReview.js';
import { runVideoAssembly, validateVideoCut } from './videoAssembly.js';
const exec = promisify(execFile);
let ffmpeg;
beforeAll(async () => {
  ffmpeg = await findFfmpeg();
  if (!ffmpeg || !await findFfprobe()) { ffmpeg = null; return; }
  await Promise.all(['videos', 'music', 'thumbnails'].map(dir => mkdir(join(state.root, dir), { recursive: true })));
  for (const [index, color] of ['red', 'blue'].entries()) await exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:r=24:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', join(state.root, 'videos', `reactor-${index}.mp4`)]);
  await exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', join(state.root, 'music', 'example-bed.wav')]);
}, 30000);
afterAll(async () => { await rm(state.root, { recursive: true, force: true }); });
beforeEach(() => {
  state.collection = [];
  state.tracks = [{ id: 'example-track', audioFilename: 'example-bed.wav' }];
  state.history = [0, 1].map(i => ({ id: `00000000-0000-4000-8000-00000000000${i}`, filename: `reactor-${i}.mp4`, width: 64, height: 64, fps: 24, numFrames: 72, modelId: 'reactor' }));
  state.project = { id: 'example-video', name: 'Example short', workspace: 'video', videoOwnerInstanceId: 'example-owner', status: 'rendering', targetDurationSeconds: 5,
    collectionId: 'example-collection', videoDraft: { durationRange: { min: 5, max: 6 }, audio: { mode: 'silent' }, transition: 'fade', sources: [], reviewPolicy: 'autonomous' },
    treatment: { script: 'A color study.', artifact: { revision: 1 }, scenes: [0, 1].map(i => ({ sceneId: `shot-${i}`, order: i, status: 'accepted', renderedJobId: `00000000-0000-4000-8000-00000000000${i}`, durationSeconds: 3 })) },
    videoExecution: { authorized: true, choices: { audio: { mode: 'silent' } }, attempts: [] } };
  state.project.videoExecution.inputRevision = videoConfigurationRevision(state.project);
});
const requireFfmpeg = context => { if (!ffmpeg) context.skip(); };

it('assembles fake Reactor clips through real Timeline, trims to target, validates, and links reusable outputs', async context => {
  requireFfmpeg(context);
  await runVideoAssembly('example-video');
  expect(state.project.failureReason).toBeNull();
  expect(state.project.status).toBe('complete');
  expect(state.project.finalVideoId).not.toBe('00000000-0000-4000-8000-000000000001');
  expect(state.project.videoFinalCut).toMatchObject({ audioMode: 'silent', durationSeconds: 5 });
  const { getProject } = await import('../videoTimeline/local.js');
  const timeline = await getProject(state.project.timelineProjectId);
  expect(timeline.segments.map(segment => segment.outSec)).toEqual([3, 2]);
  expect(timeline.segments[0].fadeOutSec).toBe(0.25);
  expect(await hasAudioStream(join(state.root, 'videos', state.project.videoFinalCut.filename))).toBe(false);
  expect(state.collection).toEqual([{ kind: 'video', ref: state.project.finalVideoId }]);
}, 30000);

it('holds real rough/final artifacts for distinct approvals and reuses the rendered file on each continuation', async context => {
  requireFfmpeg(context);
  state.project.videoDraft.reviewPolicy = 'review';
  state.project.videoExecution.inputRevision = videoConfigurationRevision(state.project);
  const approve = stage => {
    const row = videoReviewStages(state.project).find(item => item.stage === stage);
    state.project = applyVideoReviewAction(state.project, { action: 'approve', stage, revision: row.revision }, 'example-owner').project;
  };
  approve('script-shot-plan');
  await runVideoAssembly('example-video');
  expect(state.project.status).toBe('stitching');
  expect(state.project.videoRoughCut.videoId).toBeTruthy();
  expect(state.project.videoFinalCut).toBeUndefined();
  const rendered = state.history.length;
  approve('rough-cut');
  await runVideoAssembly('example-video');
  expect(state.project.videoFinalCut.videoId).toBe(state.project.videoRoughCut.videoId);
  expect(state.project.finalVideoId).toBeUndefined();
  approve('final-cut');
  await runVideoAssembly('example-video');
  expect(state.project.status).toBe('complete');
  expect(state.history.length).toBe(rendered);
}, 30000);

it('assembles directive clips and repeats an imported standalone soundtrack in the reusable Timeline', async context => {
  requireFfmpeg(context);
  state.project.directive = { goal: 'Example cut' };
  state.project.plan = { steps: [0, 1].map(i => ({ stepId: `clip-${i}`, toolName: 'media_enqueueVideoJob', status: 'done', args: { params: { durationSeconds: 3 } }, result: { jobId: `00000000-0000-4000-8000-00000000000${i}` } })) };
  state.project.videoDraft.audio = { mode: 'imported', trackId: 'example-track' };
  state.project.videoExecution.choices.audio = { ...state.project.videoDraft.audio, filename: 'example-bed.wav' };
  state.project.videoExecution.inputRevision = videoConfigurationRevision(state.project);
  await runVideoAssembly('example-video');
  expect(state.project.failureReason).toBeNull();
  expect(state.project.status).toBe('complete');
  const { getProject } = await import('../videoTimeline/local.js');
  const timeline = await getProject(state.project.timelineProjectId);
  expect(timeline.audio.tracks.map(track => track.durationSec)).toEqual([2, 2, 1]);
  expect(timeline.audio.clipVolume).toBe(0);
  expect(await hasAudioStream(join(state.root, 'videos', state.project.videoFinalCut.filename))).toBe(true);
}, 30000);

it('rejects missing, corrupt, out-of-range and missing-audio finals even when history claims completion', async context => {
  requireFfmpeg(context);
  const entry = state.history[0];
  await expect(validateVideoCut(state.project, { ...entry, filename: 'missing.mp4' })).rejects.toThrow(/not playable/);
  await writeFile(join(state.root, 'videos', 'corrupt.mp4'), 'not video');
  await expect(validateVideoCut(state.project, { ...entry, filename: 'corrupt.mp4' })).rejects.toThrow(/not playable/);
  await expect(validateVideoCut(state.project, entry)).rejects.toThrow(/outside the requested/);
  state.project.targetDurationSeconds = 3;
  state.project.videoDraft.durationRange = { min: 3, max: 3 };
  state.project.videoExecution.choices.audio.mode = 'native';
  await expect(validateVideoCut(state.project, entry)).rejects.toThrow(/missing its requested audio/);
});
