import { describe, expect, it } from 'vitest';
import { previousShot, sceneClipOutFrameSec } from './musicVideoHandoffFrame.js';

// Where a continuing shot's start frame comes from: the last frame the cut
// shows of the previous shot's clip, never the clip's own last frame.
describe('sceneClipOutFrameSec', () => {
  const shot = (extra) => ({ sceneId: 's1', startSec: 0, endSec: 4.04, loop: false, ...extra });
  it.each([
    ['a 4.04 s shot over a 5.9 s clip stops at 4.04 s, not 5.9 s', shot(), 5.9, 24, 3.998],
    ['a shot longer than its clip holds the clip\'s last frame', shot({ endSec: 8 }), 5.9, 24, 5.858],
    ['a looping shot wraps around the clip', shot({ endSec: 9, loop: true }), 6, 24, 2.958],
    ['a legacy scene without a loop key loops', { sceneId: 's1', startSec: 0, endSec: 7 }, 6, 25, 0.96],
    ['a performance take starts at its edit in-point', shot({
      endSec: 3, shotMode: 'performance', videoHistoryId: 'clip',
      takes: [{ kind: 'video', assetId: 'clip', shotInstruction: { shotMode: 'performance', edit: { inSec: 1.5, outSec: 4.5 } } }],
    }), 6, 24, 4.458],
  ])('%s', (_label, scene, durationSec, fps, expected) => {
    expect(sceneClipOutFrameSec(scene, durationSec, fps)).toBe(expected);
  });

  it('is null for an untimed shot or an unreadable clip', () => {
    expect(sceneClipOutFrameSec({ sceneId: 's1' }, 5, 24)).toBeNull();
    expect(sceneClipOutFrameSec(shot(), null, 24)).toBeNull();
  });
});

describe('previousShot', () => {
  const project = { scenes: [{ sceneId: 'b', startSec: 4, endSec: 8 }, { sceneId: 'a', startSec: 0, endSec: 4 }, { sceneId: 'loose' }] };
  it('is the shot before it in the cut, by start time', () => {
    expect(previousShot(project, 'b')?.sceneId).toBe('a');
    expect(previousShot(project, 'a')).toBeNull();
  });
});
