import { describe, expect, it } from 'vitest';
import { clipPlaybackWindow } from './musicVideoLayers.js';
import { shotRequestSpanSec } from './musicVideoShotTiming.js';
import {
  resolveSourceTake, scenePlayableClipId, sharedTakeOffers, sharedTakePatches, sourceTakeOf, sourceTakeWindows,
} from './musicVideoSourceTake.js';

const shot = (sceneId, startSec, endSec, extra = {}) => ({
  sceneId, startSec, endSec, visualLayer: 'footage', framePrompt: 'two-shot held', ...extra,
});

describe('source takes', () => {
  const windowsOf = (sourceId) => {
    const source = shot('src', 0, 1, { videoHistoryId: sourceId, referenceImageId: 'frame-src', label: 'Two-shot' });
    const returns = [0, 2, 4, 6, 8, 10].map((start, i) => shot(`r${i}`, start, start + 0.8, {
      sourceTake: { sceneId: 'src', offsetSec: start },
    }));
    return { source, scenes: [source, ...returns] };
  };

  it('plays six non-adjacent returns as six windows of one clip, and follows a changed source clip', () => {
    const { source, scenes } = windowsOf('clip-a');
    const windows = sourceTakeWindows(scenes);
    expect(windows).toHaveLength(6);
    expect(new Set(windows.map((row) => row.videoHistoryId))).toEqual(new Set(['clip-a']));
    expect(windows.map((row) => [row.inSec, row.outSec])).toEqual([
      [0, 0.8], [2, 2.8], [4, 4.8], [6, 6.8], [8, 8.8], [10, 10.8],
    ]);
    for (const row of windows) {
      const scene = scenes.find((item) => item.sceneId === row.sceneId);
      const playback = clipPlaybackWindow(scene, { inSec: row.inSec, outSec: row.outSec }, 30);
      expect(playback.inSec).toBe(row.inSec);
      expect(playback.outSec).toBe(row.outSec);
    }
    source.videoHistoryId = 'clip-b';
    expect(sourceTakeWindows(scenes).every((row) => row.videoHistoryId === 'clip-b')).toBe(true);
    expect(scenePlayableClipId(scenes[1], scenes)).toBe('clip-b');
  });

  it('defaults an omitted offset to song time since the owner started', () => {
    const scenes = [
      shot('src', 1, 2, { videoHistoryId: 'clip-a' }),
      shot('back', 4.5, 5.5, { sourceTake: { sceneId: 'src' } }),
    ];
    expect(resolveSourceTake(scenes[1], scenes)).toMatchObject({ offsetSec: 3.5, inSec: 3.5, outSec: 4.5, videoHistoryId: 'clip-a' });
  });

  it('resolves a missing source or a cycle as no source', () => {
    const a = shot('a', 0, 1, { sourceTake: { sceneId: 'b' } });
    const b = shot('b', 2, 3, { sourceTake: { sceneId: 'a' } });
    expect(resolveSourceTake(a, [a, b])).toBeNull();
    expect(resolveSourceTake(shot('a', 0, 1, { sourceTake: { sceneId: 'gone' } }), [a])).toBeNull();
    expect(sourceTakeOf(shot('a', 0, 1, { sourceTake: { sceneId: 'a' } }))).toBeNull();
    expect(scenePlayableClipId(a, [a, b])).toBeNull();
  });

  it('adds a hop when the named scene is itself a return', () => {
    const owner = shot('c', 0, 2, { videoHistoryId: 'clip-a' });
    const mid = shot('b', 3, 4, { sourceTake: { sceneId: 'c', offsetSec: 2 } });
    const back = shot('a', 5, 6, { sourceTake: { sceneId: 'b', offsetSec: 1 } });
    expect(resolveSourceTake(back, [back, mid, owner])).toMatchObject({ inSec: 3, outSec: 4, videoHistoryId: 'clip-a' });
  });

  it('sizes the source request to the last return without clamping past the stored clip length', () => {
    const source = shot('src', 0, 2, { videoHistoryId: 'clip-a' });
    const back = shot('back', 4, 5, { sourceTake: { sceneId: 'src', offsetSec: 4 } });
    expect(shotRequestSpanSec(source, [source, back])).toBe(5);
    const far = shot('far', 70, 71, { sourceTake: { sceneId: 'src', offsetSec: 70 } });
    expect(shotRequestSpanSec(source, [source, far])).toBe(71);
    expect(shotRequestSpanSec(source)).toBe(2);
  });
});

describe('shared-take offers', () => {
  it('offers sequence coverage for an adjacent run and a source take for a later return', () => {
    const scenes = [
      shot('a', 0, 0.8, { shotSheet: { cameraId: 'cam-a', location: 'room' }, label: 'Hold' }),
      shot('b', 0.8, 1.6, { shotSheet: { cameraId: 'cam-a', location: 'room' } }),
      shot('other', 1.6, 3, { framePrompt: 'flashback' }),
      shot('c', 3, 3.8, { shotSheet: { cameraId: 'cam-a', location: 'room' } }),
    ];
    const offers = sharedTakeOffers(scenes);
    expect(offers).toEqual([
      { kind: 'sequence', sceneIds: ['a', 'b'] },
      { kind: 'sourceTake', sceneId: 'c', sourceId: 'a', offsetSec: 3 },
    ]);
    expect(sharedTakePatches(scenes, offers[1])).toEqual([
      { sceneId: 'c', patch: { sourceTake: { sceneId: 'a', offsetSec: 3 } } },
      { sceneId: 'a', patch: { clipLengthSec: 3.8 } },
    ]);
    expect(sharedTakePatches(scenes, offers[0])).toEqual([
      { sceneId: 'a', patch: { coverage: 'sequence' } },
      { sceneId: 'b', patch: { coverage: 'sequence' } },
    ]);
  });

  it('does not offer a link that is already set, a blank frame, or a different camera', () => {
    const linked = [
      shot('a', 0, 1),
      shot('b', 2, 3, { sourceTake: { sceneId: 'a', offsetSec: 2 } }),
    ];
    expect(sharedTakeOffers(linked)).toEqual([]);
    expect(sharedTakeOffers([
      shot('a', 0, 1, { framePrompt: '  ' }),
      shot('b', 2, 3, { framePrompt: '  ' }),
    ])).toEqual([]);
    expect(sharedTakeOffers([
      shot('a', 0, 1, { shotSheet: { cameraId: 'cam-a' } }),
      shot('b', 2, 3, { shotSheet: { cameraId: 'cam-b' } }),
    ])).toEqual([]);
    expect(sharedTakeOffers([
      shot('a', 0, 1, { coverage: 'sequence' }),
      shot('b', 1, 2, { coverage: 'sequence' }),
    ])).toEqual([]);
  });
});
