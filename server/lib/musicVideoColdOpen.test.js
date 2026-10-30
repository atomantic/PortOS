import { describe, expect, it } from 'vitest';
import { coldOpenPlan, coldOpenSeconds, normalizePreMusic, preMusicSoundSummary, songScenes, withSongScenesOnly } from './musicVideoColdOpen.js';

const project = {
  scenes: [
    { sceneId: 'song-1', order: 0, startSec: 0, endSec: 4 },
    { sceneId: 'booth', order: 3, preMusic: { durationSec: 2.5, layers: [{ effect: 'play-button', atSec: 2 }] } },
    { sceneId: 'rink', order: 1, preMusic: { durationSec: 3, clipVolume: 0.6 } },
    { sceneId: 'song-2', order: 2, startSec: 4, endSec: 8 },
  ],
};

describe('cold open', () => {
  it('plays the marked shots first in storyboard order, on a clock of its own', () => {
    expect(coldOpenPlan(project).map(({ scene, startSec, endSec }) => [scene.sceneId, startSec, endSec]))
      .toEqual([['rink', 0, 3], ['booth', 3, 5.5]]);
    expect(coldOpenSeconds(project)).toBe(5.5);
    expect(songScenes(project).map((scene) => scene.sceneId)).toEqual(['song-1', 'song-2']);
    expect(withSongScenesOnly({ scenes: [{ sceneId: 'only' }] })).toEqual({ scenes: [{ sceneId: 'only' }] });
  });

  it('keeps settings in range and drops layers that name no sound', () => {
    expect(normalizePreMusic(null)).toBeNull();
    expect(normalizePreMusic({ durationSec: 999, clipVolume: 9, layers: [{ effect: 'unknown' }, { trackId: ' t1 ', atSec: -2, volume: 0.5 }] }))
      .toEqual({ durationSec: 120, clipVolume: 2, layers: [{ trackId: 't1', atSec: 0, durationSec: null, volume: 0.5 }] });
    expect(normalizePreMusic({}).durationSec).toBe(4);
  });

  it('says what a shot sounds like', () => {
    expect(preMusicSoundSummary({ durationSec: 2 })).toBe('Silence');
    expect(preMusicSoundSummary({ durationSec: 2, clipVolume: 0.8, layers: [{ effect: 'tape-hiss' }] })).toBe('Clip sound + Tape hiss');
    expect(preMusicSoundSummary({ durationSec: 2, layers: [{ effect: 'tape-hiss' }, { trackId: 't' }] })).toBe('2 sound layers');
  });
});
