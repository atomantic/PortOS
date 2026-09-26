import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const state = vi.hoisted(() => ({ root: '', history: [] }));
vi.mock('../../lib/fileUtils.js', async original => {
  const actual = await original();
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  state.root = await mkdtemp(join(tmpdir(), 'poster-test-'));
  return { ...actual, PATHS: { ...actual.PATHS, videos: state.root, videoThumbnails: join(state.root, 'thumbs') } };
});
vi.mock('./history.js', () => ({
  getHistoryItem: async id => state.history.find(item => item.id === id),
  mutateVideoHistory: async mutate => { state.history = await mutate(structuredClone(state.history)); },
}));
import { updateVideoPoster, createSharingCopy } from './poster.js';
import { findFfmpeg, findFfprobe, probeFrameCount, probeVideoDuration } from '../../lib/ffmpeg.js';
const exec = promisify(execFile);
let ffmpeg;
beforeAll(async () => {
  ffmpeg = await findFfmpeg();
  if (!ffmpeg || !await findFfprobe()) { ffmpeg = null; return; }
  await mkdir(join(state.root, 'thumbs'));
  await exec(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=10:d=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15', '-c:v', 'libx264', '-c:a', 'aac', '-y', join(state.root, 'example.mp4')]);
  state.history = [{ id: 'example', filename: 'example.mp4', prompt: 'Example clip' }];
}, 30000);
afterAll(async () => { await rm(state.root, { recursive: true, force: true }); });
it('persists a playhead poster, exports only a changed first frame with identical timing and audio, and resets', async context => {
  if (!ffmpeg) context.skip();
  const source = join(state.root, 'example.mp4');
  const original = await readFile(source);
  const updated = await updateVideoPoster('example', 12.4);
  expect(state.history[0]).toMatchObject({ posterSec: 12.4, thumbnail: updated.thumbnail, prompt: 'Example clip' });
  const copy = await createSharingCopy('example');
  try {
    expect(await probeFrameCount(copy.path)).toBe(await probeFrameCount(source));
    expect(await probeVideoDuration(copy.path)).toBe(await probeVideoDuration(source));
    const decode = async (path, args) => (await exec(ffmpeg, ['-v', 'error', '-i', path, ...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
    const poster = await decode(join(state.root, 'thumbs', updated.thumbnail), ['-frames:v', '1']);
    const first = await decode(copy.path, ['-frames:v', '1']);
    const mae = (a,b) => a.reduce((sum,value,i) => sum + Math.abs(value-b[i]), 0) / a.length;
    expect(first.length).toBe(poster.length);
    expect(mae(first, poster)).toBeLessThan(8);
    const tail = ['-vf', 'select=gte(n\\,1)', '-fps_mode', 'passthrough'];
    expect(mae(await decode(copy.path, tail), await decode(source, tail))).toBeLessThan(8);
    const audio = async path => (await exec(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', '-'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
    expect(await audio(copy.path)).toEqual(await audio(source));
    expect(await readFile(source)).toEqual(original);
  } finally { await copy.cleanup(); }
  const clamped = await updateVideoPoster('example', 100);
  expect(clamped.posterSec).toBeCloseTo(14.9);
  const reset = await updateVideoPoster('example', null);
  expect(reset.posterSec).toBeNull();
  expect(state.history[0]).not.toHaveProperty('posterSec');
  expect(reset.thumbnail).not.toBe(updated.thumbnail);
}, 30000);
it('rejects missing and unsafe history entries without creating a download', async () => {
  await expect(updateVideoPoster('missing', 1)).rejects.toMatchObject({ status: 404 });
  state.history.push({ id: 'unsafe', filename: '../private.mp4', thumbnail: '../private.jpg' });
  await expect(createSharingCopy('unsafe')).rejects.toMatchObject({ status: 404 });
});
