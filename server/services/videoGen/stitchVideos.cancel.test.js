import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-stitch-cancel-') }) };
});
afterAll(cleanupTempDataRoots);

const state = vi.hoisted(() => ({ proc: null, kills: [], published: false }));

vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(() => {
    const proc = new EventEmitter();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = (sig) => {
      state.kills.push(sig);
      proc.signalCode = sig;
      queueMicrotask(() => proc.emit('close', null));
    };
    state.proc = proc;
    return proc;
  }),
}));
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findFfmpeg: vi.fn(async () => 'ffmpeg'),
  safeUnder: vi.fn((base, name) => join(base, name)),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  optimizeForStreaming: vi.fn(async () => {}),
  hasAudioStream: vi.fn(async () => true),
  buildTrimConcatArgs: vi.fn(),
  bt709TagFilter: vi.fn(async () => null),
}));
vi.mock('./generateVideoHelpers.js', () => ({ discardUnpublishedVideo: vi.fn() }));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal()), existsSync: () => true }));
vi.mock('./history.js', () => ({
  loadHistory: vi.fn(async () => ['a', 'b'].map((id) => ({ id, filename: `${id}.mp4`, prompt: id, modelId: 'm', width: 1, height: 1, fps: 24 }))),
  mutateVideoHistory: vi.fn(async () => { state.published = true; }),
}));

const { stitchVideos } = await import('./stitchVideos.js');
const { PATHS } = await import('../../lib/fileUtils.js');

beforeEach(async () => {
  state.proc = null;
  state.kills.length = 0;
  state.published = false;
  await mkdir(PATHS.videos, { recursive: true });
});

describe('stitchVideos unpublished outputs', () => {
  it('kills the ffmpeg child and removes its partial output on cancellation', async () => {
    const abort = new AbortController();
    const out = join(PATHS.videos, 'stitched-job-x.mp4');
    const run = stitchVideos(['a', 'b'], { id: 'job-x', signal: abort.signal });
    await vi.waitFor(() => expect(state.proc).not.toBeNull());
    await writeFile(out, 'partial mp4');
    abort.abort();
    await expect(run).rejects.toMatchObject({ code: 'STITCH_CANCELED' });
    expect(state.kills).toContain('SIGTERM');
    expect(state.published).toBe(false);
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the partial output when a normal concat exits unsuccessfully', async () => {
    const out = join(PATHS.videos, 'stitched-job-y.mp4');
    const run = stitchVideos(['a', 'b'], { id: 'job-y' });
    await vi.waitFor(() => expect(state.proc).not.toBeNull());
    await writeFile(out, 'partial mp4');
    state.proc.emit('close', 1);
    await expect(run).rejects.toMatchObject({ code: 'FFMPEG_FAILED' });
    expect(state.published).toBe(false);
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
