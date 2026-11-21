import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async (actual) => makePathsProxy(await actual(), { dataRoot: () => lazyTempDataRoot('portos-shot-download-test-') }));
const state = vi.hoisted(() => ({ project: null }));
vi.mock('./projects.js', () => ({ getProject: vi.fn(async () => state.project) }));
vi.mock('../videoGen/history.js', async (actual) => ({
  ...await actual(),
  loadHistory: vi.fn(async () => [{ id: 'clip', filename: 'clip.mp4', numFrames: 96, fps: 24, width: 64, height: 64, trimmedFrom: 'original', trimStartSec: 1 }]),
}));
vi.mock('./performanceShot.js', () => ({ assertCurrentPerformanceTakes: vi.fn(async () => {}) }));

const available = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const { PATHS } = await import('../../lib/fileUtils.js');
const { renderShotDownload } = await import('./shotDownload.js');

describe.skipIf(!available)('shot download with real media', () => {
  beforeAll(() => {
    mkdirSync(PATHS.videos, { recursive: true });
    mkdirSync(PATHS.music, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:size=64x64:rate=24:duration=1', '-f', 'lavfi', '-i', 'color=blue:size=64x64:rate=24:duration=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(PATHS.videos, 'clip.mp4')]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', join(PATHS.music, 'song.wav')]);
  });
  afterAll(cleanupTempDataRoots);
  it('uses the shot song window and the selected clip offset, with phone-compatible streams', async () => {
    state.project = { uploadedAudioFilename: 'song.wav', scenes: [{ sceneId: 's', startSec: 2, endSec: 3, videoHistoryId: 'clip', offsetFrames: 36, loop: false }] };
    const output = await renderShotDownload('p', 's');
    try {
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output.path]));
      expect(probe.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac']);
      expect(Number(probe.format.duration)).toBeCloseTo(1, 1);
      const pixel = execFileSync('ffmpeg', ['-v', 'error', '-i', output.path, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      expect(pixel[2]).toBeGreaterThan(pixel[0] + 100);
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', output.path, '-vn', '-t', '0.5', '-ar', '8000', '-ac', '1', '-f', 's16le', '-']);
      let crossings = 0;
      for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) < 0 && pcm.readInt16LE(i) >= 0) crossings++;
      expect(crossings).toBeGreaterThan(400);
      expect(crossings).toBeLessThan(480);
    } finally { await output.cleanup(); }
  });
  it('resolves a return into its source take and shortens a non-looping source', async () => {
    state.project = { uploadedAudioFilename: 'song.wav', scenes: [
      { sceneId: 'owner', startSec: 0, endSec: 1, videoHistoryId: 'clip' },
      { sceneId: 'return', startSec: 2, endSec: 4, sourceTake: { sceneId: 'owner', offsetSec: 3 }, loop: false },
    ] };
    const output = await renderShotDownload('p', 'return');
    try {
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', output.path]));
      expect(Number(probe.format.duration)).toBeCloseTo(1, 1);
      const pixel = execFileSync('ffmpeg', ['-v', 'error', '-i', output.path, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      expect(pixel[2]).toBeGreaterThan(pixel[0] + 100);
    } finally { await output.cleanup(); }
  });
  it('honors a padded performance take’s edit in-point', async () => {
    const scene = { sceneId: 's', startSec: 2, endSec: 3, videoHistoryId: 'clip', shotMode: 'performance', takes: [
      { kind: 'video', assetId: 'clip', shotInstruction: { shotMode: 'performance', edit: { inSec: 1.5, outSec: 2.5 }, audioWindow: { startSec: 0.5 } } },
    ] };
    state.project = { uploadedAudioFilename: 'song.wav', scenes: [scene] };
    const output = await renderShotDownload('p', 's');
    try {
      const pixel = execFileSync('ffmpeg', ['-v', 'error', '-i', output.path, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      expect(pixel[2]).toBeGreaterThan(pixel[0] + 100);
    } finally { await output.cleanup(); }
  });
  it('cleans up an interrupted encode and can prepare the same shot again', async () => {
    state.project = { uploadedAudioFilename: 'song.wav', scenes: [{ sceneId: 's', startSec: 0, endSec: 1, videoHistoryId: 'clip', loop: false }] };
    const controller = new AbortController();
    controller.abort();
    await expect(renderShotDownload('p', 's', controller.signal)).rejects.toMatchObject({ code: 'SHOT_RENDER_FAILED' });
    const output = await renderShotDownload('p', 's');
    await output.cleanup();
  });
  it('refuses absent audio, missing clips and song windows beyond the audio', async () => {
    state.project = { scenes: [{ sceneId: 's', startSec: 0, endSec: 1, videoHistoryId: 'clip' }] };
    await expect(renderShotDownload('p', 's')).rejects.toMatchObject({ code: 'NO_AUDIO' });
    state.project.uploadedAudioFilename = 'song.wav';
    state.project.scenes[0].videoHistoryId = null;
    await expect(renderShotDownload('p', 's')).rejects.toMatchObject({ code: 'NO_SCENE_CLIP' });
    state.project.scenes[0] = { sceneId: 's', startSec: 3, endSec: 5, videoHistoryId: 'clip' };
    await expect(renderShotDownload('p', 's')).rejects.toMatchObject({ code: 'AUDIO_TOO_SHORT' });
  });
  it('refuses a request based on unsaved shot settings', async () => {
    state.project = { uploadedAudioFilename: 'song.wav', scenes: [{ sceneId: 's', startSec: 0, endSec: 1, videoHistoryId: 'clip' }] };
    await expect(renderShotDownload('p', 's', undefined, 'outdated')).rejects.toMatchObject({ code: 'SHOT_CHANGED' });
  });
});
