/**
 * Continuing shots against a real ffmpeg: the handoff frame is the last frame
 * the cut shows of the previous shot's clip, and it becomes this shot's start
 * frame (optionally moving the planned still to the end frame).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = mkdtempSync(join(tmpdir(), 'mv-continue-shot-'));
const mocks = vi.hoisted(() => ({ project: null, appended: [], selected: [] }));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, videos: join(ROOT, 'videos'), images: join(ROOT, 'images') } };
});
vi.mock('../instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'local-inst' }));
vi.mock('../videoGen/history.js', () => ({ getHistoryItem: vi.fn(async (id) => (['clip-a', 'clip-30'].includes(id) ? { id, filename: `${id}.mp4` } : null)) }));
vi.mock('./projects.js', () => ({
  getProject: vi.fn(async () => mocks.project),
  appendSceneTakes: vi.fn(async (_id, _sceneId, inputs) => {
    mocks.appended.push(...inputs);
    return { appended: inputs.map((input, i) => ({ ...input, takeId: `t${mocks.appended.length - inputs.length + i}` })) };
  }),
  selectSceneTake: vi.fn(async (_id, sceneId, takeId) => { mocks.selected.push(takeId); return { sceneId }; }),
}));

const { findFfmpeg, runFfmpegProcess, probeVideoStreamInfo } = await import('../../lib/ffmpeg.js');
const { continueFromPreviousShot } = await import('./continueShot.js');
const ffmpeg = await findFfmpeg();

describe.skipIf(!ffmpeg)('continueFromPreviousShot', () => {
  beforeAll(async () => {
    mkdirSync(join(ROOT, 'videos'), { recursive: true });
    // A 3 s clip under a 1 s shot.
    const made = await runFfmpegProcess({ bin: ffmpeg, args: ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=3', '-pix_fmt', 'yuv420p', join(ROOT, 'videos', 'clip-a.mp4')] });
    expect(made.ok).toBe(true);
    const thirty = await runFfmpegProcess({ bin: ffmpeg, args: ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=1', '-pix_fmt', 'yuv420p', join(ROOT, 'videos', 'clip-30.mp4')] });
    expect(thirty.ok).toBe(true);
  });
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it('extracts the frame at the previous shot\'s out-point and keeps the planned still as the end frame', async () => {
    mocks.project = { id: 'mv-1', scenes: [
      { sceneId: 'a', startSec: 0, endSec: 1, loop: false, videoHistoryId: 'clip-a' },
      { sceneId: 'b', startSec: 1, endSec: 3, referenceImageId: 'planned.png' },
    ] };
    const { frame } = await continueFromPreviousShot('mv-1', 'b', { keepStillAsEnd: true });
    expect(frame).toEqual({ imageId: 'handoff-clip-a-958.png', atSec: 0.958, fromSceneId: 'a' });
    expect(existsSync(join(ROOT, 'images', frame.imageId))).toBe(true);
    expect((await probeVideoStreamInfo(join(ROOT, 'images', frame.imageId))).width).toBe(320);
    expect(mocks.appended.map((t) => [t.kind, t.assetId])).toEqual([['image', 'handoff-clip-a-958.png'], ['endImage', 'planned.png']]);
    expect(mocks.selected).toEqual(['t0', 't1']);
  });

  // Uniquely catches a handoff frame with no owner: its delete would send peers no realtime frame.
  it('names this machine as the handoff frame\'s origin and refreshes the stamp when the frame is re-extracted', async () => {
    mocks.project = { id: 'mv-1', scenes: [
      { sceneId: 'a', startSec: 0, endSec: 1, loop: false, videoHistoryId: 'clip-a' },
      { sceneId: 'b', startSec: 1, endSec: 3 },
    ] };
    const sidecar = join(ROOT, 'images', 'handoff-clip-a-958.metadata.json');
    await continueFromPreviousShot('mv-1', 'b');
    const first = JSON.parse(readFileSync(sidecar, 'utf8'));
    expect(first.originInstanceId).toBe('local-inst');
    expect(Number.isFinite(Date.parse(first.createdAt))).toBe(true);
    // Same name, kept frame: the sidecar is left as it is.
    await continueFromPreviousShot('mv-1', 'b');
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual(first);
    // Deleted and extracted again under the same name: a stale sidecar is replaced with a newer stamp.
    unlinkSync(join(ROOT, 'images', 'handoff-clip-a-958.png'));
    writeFileSync(sidecar, JSON.stringify({ originInstanceId: 'old', createdAt: '2000-01-01T00:00:00.000Z' }));
    await continueFromPreviousShot('mv-1', 'b');
    const again = JSON.parse(readFileSync(sidecar, 'utf8'));
    expect(again.originInstanceId).toBe('local-inst');
    expect(Date.parse(again.createdAt)).toBeGreaterThan(Date.parse(first.createdAt) - 1);
  });

  // Uniquely catches a still shot handing over the stale clip it kept, which the cut never shows.
  it('starts from a still shot\'s end frame, never its stale clip', async () => {
    mocks.appended.length = 0; mocks.selected.length = 0;
    mocks.project = { id: 'mv-1', composition: { mode: 'composed' }, scenes: [
      { sceneId: 'a', startSec: 0, endSec: 1, visualLayer: 'still', imageEffect: 'end-glitch', referenceImageId: 'still.png', endImageId: 'end.png', videoHistoryId: 'clip-a' },
      { sceneId: 'b', startSec: 1, endSec: 3 },
    ] };
    const { frame } = await continueFromPreviousShot('mv-1', 'b');
    expect(frame).toEqual({ imageId: 'end.png', atSec: null, fromSceneId: 'a' });
    expect(mocks.appended.map((t) => [t.kind, t.assetId])).toEqual([['image', 'end.png']]);
  });

  it('continues from the last displayed photo in a repeating still sequence', async () => {
    mocks.appended.length = 0; mocks.selected.length = 0;
    mocks.project = { id: 'mv-1', composition: { mode: 'composed' }, scenes: [
      { sceneId: 'a', startSec: 0, endSec: 1, visualLayer: 'still', referenceImageId: 'unused.png',
        photoSequence: { imageIds: ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'], intervalFrames: 6 } },
      { sceneId: 'b', startSec: 1, endSec: 3 },
    ] };
    const { frame } = await continueFromPreviousShot('mv-1', 'b');
    expect(frame).toEqual({ imageId: 'four.png', atSec: null, fromSceneId: 'a' });
    expect(mocks.appended.map(t => [t.kind, t.assetId])).toEqual([['image', 'four.png']]);
  });

  it('refuses the first shot and a previous shot without a clip', async () => {
    mocks.project = { id: 'mv-1', scenes: [{ sceneId: 'a', startSec: 0, endSec: 1 }, { sceneId: 'b', startSec: 1, endSec: 2 }] };
    await expect(continueFromPreviousShot('mv-1', 'a')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_NO_PREVIOUS_SHOT' });
    await expect(continueFromPreviousShot('mv-1', 'b')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_PREVIOUS_CLIP_MISSING' });
  });

  it('uses the composed render frame rate when continuing a photo sequence', async () => {
    mocks.appended.length = 0; mocks.selected.length = 0;
    mocks.project = { id: 'mv-1', composition: { mode: 'composed' }, scenes: [
      { sceneId: 'lead', order: 0, startSec: 0, endSec: 0.5, videoHistoryId: 'clip-30' },
      { sceneId: 'photos', order: 1, startSec: 0.5, endSec: 1.5, visualLayer: 'still',
        photoSequence: { imageIds: ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'], intervalFrames: 6 } },
      { sceneId: 'next', order: 2, startSec: 1.5, endSec: 3 },
    ] };
    const { frame } = await continueFromPreviousShot('mv-1', 'next');
    expect(frame).toEqual({ imageId: 'five.png', atSec: null, fromSceneId: 'photos' });
  });
});
