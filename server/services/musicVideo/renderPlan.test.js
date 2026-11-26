import { basename } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('fs', async (load) => ({ ...await load(), existsSync: () => true }));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(),
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  probeVideoDuration: vi.fn(async () => 30),
  probeVideoGeometry: vi.fn(),
  hasAudioStream: vi.fn(),
}));
vi.mock('../videoGen/history.js', async (load) => ({ ...await load(), loadHistory: vi.fn() }));

import { hasAudioStream, probeVideoGeometry } from '../../lib/ffmpeg.js';
import { loadHistory } from '../videoGen/history.js';
import { planMusicVideoRender } from './renderPlan.js';

describe('planMusicVideoRender clip probes', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shares history and deduplicates bounded probes without changing the cut order', async () => {
    const files = ['shared.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4', 'f.mp4'];
    const geometry = { width: 768, height: 512, fps: 24, numFrames: 96 };
    const measured = { id: 'measured', filename: 'recorded.mp4', ...geometry };
    loadHistory.mockResolvedValue([
      ...files.map((filename) => ({ id: filename, filename })),
      { id: 'alternate-id', filename: 'shared.mp4' },
      measured,
    ]);

    let active = 0;
    const peaks = { geometry: 0, audio: 0 };
    const recordConcurrency = async (kind, result) => {
      peaks[kind] = Math.max(peaks[kind], ++active);
      await Promise.resolve();
      active--;
      return result;
    };
    probeVideoGeometry.mockImplementation(() => recordConcurrency('geometry', geometry));
    hasAudioStream.mockImplementation((path) => recordConcurrency('audio', basename(path) !== 'f.mp4'));
    const songScenes = [...files, 'alternate-id', 'measured'].map((videoHistoryId, order) => ({
      sceneId: `song-${order}`, order, videoHistoryId,
      ...(videoHistoryId === 'measured' ? {} : { clipSound: { volume: order === 6 ? 0.5 : 1 } }),
    }));

    const plan = await planMusicVideoRender({
      uploadedAudioFilename: 'master.wav',
      scenes: [
        ...songScenes.toReversed(),
        { sceneId: 'cold-open', videoHistoryId: 'alternate-id', preMusic: { durationSec: 2 } },
      ],
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(plan.coldOpen.clips).toEqual([expect.objectContaining({ sceneId: 'cold-open', duration: 2 })]);
    expect(plan.clips.map(({ sceneId }) => sceneId)).toEqual(songScenes.map(({ sceneId }) => sceneId));
    expect(plan.clips.map(({ clipSound }) => clipSound?.volume)).toEqual([1, 1, 1, 1, 1, undefined, 0.5, undefined]);
    expect(probeVideoGeometry.mock.calls.map(([path]) => basename(path))).toEqual(files);
    expect(hasAudioStream.mock.calls.map(([path]) => basename(path))).toEqual(files);
    expect(peaks).toEqual({ geometry: 4, audio: 4 });
  });

  it('leaves video history unread for a card-only composition', async () => {
    const plan = await planMusicVideoRender({
      uploadedAudioFilename: 'master.wav',
      composition: { mode: 'composed' },
      scenes: [{ sceneId: 'title', visualLayer: 'card', startSec: 0, endSec: 4 }],
    });

    expect(plan.clips).toEqual([expect.objectContaining({ sceneId: 'title', layer: 'card' })]);
    expect(loadHistory).not.toHaveBeenCalled();
  });
});
