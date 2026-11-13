import { describe, expect, it } from 'vitest';
import { makeSong } from './song.js';

describe('cel shot clock', () => {
  // Uniquely pins pickup-aware bar timing through irregular tracked beats and extrapolation.
  it('counts bars from a chosen anchor and round-trips irregular beat positions', () => {
    const song = makeSong({ song: { beats: [0.2, 0.7, 1.3, 1.8, 2.4], downbeats: [1.3] } });
    expect(song.barTime(1)).toBeCloseTo(1.3);
    expect(song.barAt(1.3)).toBe(1);
    for (const beat of [-2, 0, 1.5, 3.25, 7]) expect(song.beatAt(song.beatTime(beat))).toBeCloseTo(beat);
    const shifted = makeSong({ song: { beats: [0, 0.5, 1, 1.5] } }, { anchorSec: 0.75, beatsPerBar: 3 });
    expect(shifted.barTime(2)).toBeCloseTo(2.25);
    expect(shifted.barAt(2.25)).toBe(2);
  });

  // A no-analysis project must still preview the two template shots with a usable clock.
  it('uses a zero-origin fallback and reads the supplied tempo without analysis', () => {
    const fallback = makeSong();
    expect(fallback.barTime(1)).toBe(0);
    expect(fallback.barTime(2)).toBe(2);
    const song = makeSong({ song: { bpm: 90 }, render: { durationSec: 12 } });
    expect(song.barTime(2)).toBeCloseTo(8 / 3);
    expect(song.durationSec).toBe(12);
  });
});
