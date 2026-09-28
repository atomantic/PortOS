import { describe, it, expect } from 'vitest';
import { planShotSplit, shotSplitLimit, SOURCE_AUDIO_LIPSYNC, PERFORMANCE_WINDOW_MARGIN_SEC } from './musicVideoShotTiming.js';

// The split planner is an algorithm with a real input matrix (#8977): which
// boundary wins, how many pieces, and exact coverage are each ambiguous when
// seen only through the scene-split route, which asserts the record outcome.

const coverage = (pieces) => pieces.map((p) => [p.startSec, p.endSec]);
const expectContiguous = (pieces, startSec, endSec, maxSec) => {
  expect(pieces[0].startSec).toBe(startSec);
  expect(pieces.at(-1).endSec).toBe(endSec);
  for (let i = 1; i < pieces.length; i += 1) expect(pieces[i].startSec).toBe(pieces[i - 1].endSec);
  for (const p of pieces) expect(p.endSec - p.startSec).toBeLessThanOrEqual(maxSec + 1e-6);
};

describe('planShotSplit', () => {
  it('cuts in the pause between two sung lines rather than at the even midpoint', () => {
    const lyricCues = [
      { text: 'first line', startSec: 40, endSec: 47 },
      { text: 'second line', startSec: 49, endSec: 58 },
    ];
    const plan = planShotSplit({ startSec: 40, endSec: 60, maxSec: 14.75, lyricCues });
    expect(plan.ok).toBe(true);
    expect(coverage(plan.pieces)).toEqual([[40, 48], [48, 60]]);
    expect(plan.pieces.map((p) => p.cut)).toEqual(['pause', null]);
  });

  it('never cuts inside a sung line on a lyric/phrase boundary; falls to a beat, then an even cut', () => {
    // One long line covers the whole reachable cut range — only a beat may land inside it.
    const lyricCues = [{ text: 'held note', startSec: 0, endSec: 20 }];
    const phrases = [{ startSec: 9, endSec: 11, intent: 'turn' }];
    const onBeat = planShotSplit({ startSec: 0, endSec: 20, maxSec: 10.5, lyricCues, phrases, beats: [9.5, 10.2] });
    expect(coverage(onBeat.pieces)).toEqual([[0, 10.2], [10.2, 20]]);
    expect(onBeat.pieces[0].cut).toBe('beat');
    const even = planShotSplit({ startSec: 0, endSec: 20, maxSec: 10.5, lyricCues, phrases });
    expect(coverage(even.pieces)).toEqual([[0, 10], [10, 20]]);
    expect(even.pieces[0].cut).toBe('even');
  });

  it('uses the fewest pieces, each within the limit, covering the span exactly', () => {
    const plan = planShotSplit({ startSec: 12.5, endSec: 43.7, maxSec: 10 });
    expect(plan.pieces).toHaveLength(4);
    expectContiguous(plan.pieces, 12.5, 43.7, 10);
    // A phrase boundary out of reach of a feasible cut is ignored rather than
    // leaving a remainder too long for the pieces left.
    const reach = planShotSplit({ startSec: 0, endSec: 29, maxSec: 10, phrases: [{ startSec: 2, endSec: 3 }] });
    expect(reach.pieces).toHaveLength(3);
    expectContiguous(reach.pieces, 0, 29, 10);
  });

  it('adds at most one piece to keep every cut out of a sung line', () => {
    // Two pieces would have to cut inside the 9–21 line; three cut at 8.5 and 21.5.
    const lyricCues = [
      { text: 'a', startSec: 0, endSec: 8 },
      { text: 'b', startSec: 9, endSec: 21 },
      { text: 'c', startSec: 22, endSec: 28 },
    ];
    const clean = planShotSplit({ startSec: 0, endSec: 28, maxSec: 14.75, lyricCues });
    expect(coverage(clean.pieces)).toEqual([[0, 8.5], [8.5, 21.5], [21.5, 28]]);
    // A single 20s line cannot be cleanly cut even with an extra piece: keep the fewest.
    const held = planShotSplit({ startSec: 0, endSec: 20, maxSec: 14.75, lyricCues: [{ text: 'held', startSec: 0, endSec: 20 }] });
    expect(held.pieces).toHaveLength(2);
  });

  it('refuses an untimed shot and one that already fits the limit (boundary inclusive)', () => {
    expect(planShotSplit({ startSec: null, endSec: 30, maxSec: 10 })).toMatchObject({ ok: false, code: 'MUSIC_VIDEO_SPLIT_UNTIMED' });
    expect(planShotSplit({ startSec: 5, endSec: 15, maxSec: 10 })).toMatchObject({ ok: false, code: 'MUSIC_VIDEO_SPLIT_NOT_NEEDED' });
    expect(planShotSplit({ startSec: 5, endSec: 15.01, maxSec: 10 }).pieces).toHaveLength(2);
    // Just past an exact multiple still needs the extra piece; float noise at it does not.
    expect(planShotSplit({ startSec: 0, endSec: 20.00001, maxSec: 10 }).pieces).toHaveLength(3);
    expect(32.2 - 2.2).toBeGreaterThan(30);
    expect(planShotSplit({ startSec: 2.2, endSec: 32.2, maxSec: 10 }).pieces).toHaveLength(3);
  });
});

describe('shotSplitLimit', () => {
  it('bounds a performance by the lip-sync window and a Grok footage cutaway by its longest clip', () => {
    const fal = SOURCE_AUDIO_LIPSYNC.fal;
    expect(shotSplitLimit({ shotMode: 'performance' }, 'fal')).toBeCloseTo(fal.maxAudioSec - PERFORMANCE_WINDOW_MARGIN_SEC, 6);
    expect(shotSplitLimit({ shotMode: 'cutaway' }, 'grok')).toBe(10);
    // Blocked outright (not split) or unbounded lanes have no limit.
    expect(shotSplitLimit({ shotMode: 'performance' }, 'grok')).toBeNull();
    expect(shotSplitLimit({ shotMode: 'cutaway' }, 'fal')).toBeNull();
    expect(shotSplitLimit({ shotMode: 'cutaway', visualLayer: 'still' }, 'grok')).toBeNull();
  });
});
