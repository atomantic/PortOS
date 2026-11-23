/** Motion references through the public film workflow: record, strip, staleness, sync and a missing video. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { blenderMotionReferenceTimes, normalizeBlenderRecord } from '../../lib/musicVideo/musicVideoBlender.js';
import { createFakeBlender, exampleManifest } from '../musicVideo/blender/__blenderFixture.js';
import { scaffoldBlenderWorkspace } from './sources.js';
import { startBlenderSync } from './sync.js';
import { enqueueBlenderRenders } from './queue.js';
import { getBlenderState } from './state.js';
import { listBlenderJobs, __resetBlenderJobsForTests } from './jobs.js';
import { makeBlenderMotionStrip, saveBlenderMotionReferences } from './motionReferences.js';

function ROOT() { return lazyTempDataRoot('film-motion-ref-test-'); }
const runtime = vi.hoisted(() => ({ blender: null, ffmpeg: [] }));
vi.mock('../../lib/paths.js', async (load) => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('../codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => runtime.blender.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => runtime.blender.resolveBlenderTool(...args),
}));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(), findFfmpeg: vi.fn(async () => '/opt/example/ffmpeg'), bt709TagFilter: vi.fn(async () => null),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    runtime.ffmpeg.push(args);
    writeFileSync(args.at(-1), 'image');
    return { ok: true };
  }),
}));
afterAll(() => { __resetBlenderJobsForTests(); cleanupTempDataRoots(); });
beforeEach(() => {
  __resetBlenderJobsForTests(); cleanupTempDataRoots(); runtime.ffmpeg = [];
  runtime.blender = createFakeBlender();
  runtime.blender.control.manifest = exampleManifest();
});

function createOwner() {
  let record = normalizeBlenderRecord({});
  return {
    kind: 'standalone-test', id: 'example-film', workspaceDir: join(ROOT(), 'standalone', 'example-film'),
    timeline: async () => ({ durationSec: 6, fps: record.settings.fps }),
    song: async () => null,
    readRecord: async () => record,
    writeRecord: async (change) => { record = { ...record, ...change(record) }; return record; },
    emit: () => {},
  };
}
const settled = (owner, ids) => vi.waitFor(() => {
  const jobs = listBlenderJobs({ ...owner }).filter((job) => ids.includes(job.id));
  expect(jobs.map((job) => job.status)).toEqual(ids.map(() => 'done'));
}, { timeout: 20_000, interval: 20 });
const addVideo = (name) => {
  mkdirSync(join(ROOT(), 'videos'), { recursive: true });
  writeFileSync(join(ROOT(), 'videos', name), 'video');
};
const ref = (patch = {}) => ({ filename: 'example-walk.mp4', inSec: 1, outSec: 5, speed: 2, note: 'read the footfall order', ...patch });

async function syncedFilm() {
  const owner = createOwner();
  await scaffoldBlenderWorkspace(owner);
  for (const shot of runtime.blender.control.manifest.shots) writeFileSync(join(owner.workspaceDir, 'src', 'shots', `${shot.id}.py`), '# example shot');
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  return owner;
}

it('lines a 2x reference up with a 4 s shot column for column', () => {
  const shot = { id: 's1', start: 2, end: 6 };
  // 24 fps, a tile every 12 frames (0.5 s of shot): the reference advances 1 s per tile at 2x.
  const times = blenderMotionReferenceTimes({ shot, ref: { inSec: 1, outSec: 5, speed: 2 }, fps: 24, every: 12, firstFrame: 48, tiles: 8 });
  expect(times).toEqual([1, 2, 3, 4, null, null, null, null]);
});

it('reads a record written before motion references as having none', () => {
  expect(normalizeBlenderRecord({ settings: { fps: 24 } }).motionReferences).toEqual({});
  expect(normalizeBlenderRecord({ motionReferences: { s010: [{ id: 'a', filename: 'v.mp4', inSec: 3, outSec: 1, speed: 1 }] } }).motionReferences).toEqual({});
});

it('saves references without marking any render stale, tiles the strip on the sheet grid and reports a deleted video as missing', async () => {
  const owner = await syncedFilm();
  addVideo('example-walk.mp4');
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'preview', shotIds: ['s010'] })).jobs.map((job) => job.id));
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'sheet', shotIds: ['s010'], sheet: { every: 6, columns: 4 } })).jobs.map((job) => job.id));
  const before = (await getBlenderState(owner)).renders.s010;
  expect(before.preview.stale).toBe(false);

  await saveBlenderMotionReferences(owner, 's010', [ref()]);
  let state = await getBlenderState(owner);
  expect(state.renders.s010.preview).toEqual(before.preview);
  expect(state.renders.s010.sheets.map((sheet) => sheet.stale)).toEqual(before.sheets.map((sheet) => sheet.stale));
  const [saved] = state.motionReferences.s010;
  expect(saved).toMatchObject({ filename: 'example-walk.mp4', speed: 2, missing: false, strip: { columns: 4, every: 6, current: true } });
  expect(existsSync(saved.strip.path)).toBe(true);
  // A tile every 6 frames at 24 fps is 0.25 s of shot, so 0.5 s of reference at 2x.
  expect(runtime.ffmpeg.at(-1).join(' ')).toContain('fps=fps=1/0.5');

  const made = await makeBlenderMotionStrip(owner, 's010', saved.id, { sheet: before.sheets[0].file });
  expect(made).toMatchObject({ columns: 4, every: 6, sheet: before.sheets[0].file.split('/').pop() });

  rmSync(join(ROOT(), 'videos', 'example-walk.mp4'));
  state = await getBlenderState(owner);
  expect(state.motionReferences.s010[0]).toMatchObject({ missing: true, strip: { current: false } });
  expect(state.renders.s010.preview.stale).toBe(before.preview.stale);
  await expect(makeBlenderMotionStrip(owner, 's010', saved.id)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_REFERENCE_MISSING' });
  // The shot still renders.
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'preview', shotIds: ['s010'], force: true })).jobs.map((job) => job.id));
});

it('refuses a fourth reference and a video that is not in Media History, and drops a removed reference with its strip', async () => {
  const owner = await syncedFilm();
  addVideo('example-walk.mp4');
  await expect(saveBlenderMotionReferences(owner, 's010', [ref(), ref(), ref(), ref()])).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_REFERENCE_INVALID' });
  await expect(saveBlenderMotionReferences(owner, 's010', [ref({ filename: 'missing.mp4' })])).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_REFERENCE_INVALID' });
  await expect(saveBlenderMotionReferences(owner, 'nope', [ref()])).rejects.toMatchObject({ status: 404 });
  await saveBlenderMotionReferences(owner, 's010', [ref()]);
  const { path } = (await getBlenderState(owner)).motionReferences.s010[0].strip;
  await saveBlenderMotionReferences(owner, 's010', []);
  expect((await getBlenderState(owner)).motionReferences).toEqual({});
  expect(existsSync(path)).toBe(false);
});

it('drops the references of a shot that a sync removed', async () => {
  const owner = await syncedFilm();
  addVideo('example-walk.mp4');
  await saveBlenderMotionReferences(owner, 's020', [ref()]);
  runtime.blender.control.manifest.shots = runtime.blender.control.manifest.shots.filter((shot) => shot.id !== 's020');
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  expect((await getBlenderState(owner)).motionReferences).toEqual({});
  expect((await owner.readRecord()).motionReferences).toEqual({});
});
