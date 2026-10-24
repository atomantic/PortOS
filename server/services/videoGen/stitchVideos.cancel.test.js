import { describe, it, expect, vi, afterAll } from 'vitest';
import { EventEmitter } from 'events';
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
vi.mock('../../lib/ffmpeg.js', () => ({
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

describe('stitchVideos cancellation', () => {
  it('kills the ffmpeg child and publishes no history row', async () => {
    const abort = new AbortController();
    const run = stitchVideos(['a', 'b'], { id: 'job-x', signal: abort.signal });
    await vi.waitFor(() => expect(state.proc).not.toBeNull());
    abort.abort();
    await expect(run).rejects.toMatchObject({ code: 'STITCH_CANCELED' });
    expect(state.kills).toContain('SIGTERM');
    expect(state.published).toBe(false);
  });
});
