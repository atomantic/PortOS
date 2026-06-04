import { describe, it, expect } from 'vitest';
import { placeCuesOnTimeline } from './audioCuePlacement.js';

describe('placeCuesOnTimeline', () => {
  it('returns [] for empty / non-array input', () => {
    expect(placeCuesOnTimeline([], 100)).toEqual([]);
    expect(placeCuesOnTimeline(null, 100)).toEqual([]);
  });

  it('leaves timing null when the duration is unknown', () => {
    const cues = [{ id: 'cue-001' }, { id: 'cue-002' }];
    const placed = placeCuesOnTimeline(cues, null);
    expect(placed).toHaveLength(2);
    expect(placed.every((c) => c.startSec === null && c.endSec === null)).toBe(true);
  });

  it('leaves timing null for a non-positive duration', () => {
    const placed = placeCuesOnTimeline([{ id: 'cue-001' }], 0);
    expect(placed[0].startSec).toBeNull();
  });

  it('tiles cues evenly end-to-end across the episode, last cue pinned to the end', () => {
    const cues = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const placed = placeCuesOnTimeline(cues, 90);
    // Equal stretch per cue: 30s each.
    expect(placed[0].startSec).toBe(0);
    expect(placed[0].endSec).toBeCloseTo(30, 5);
    expect(placed[1].startSec).toBeCloseTo(30, 5);
    expect(placed[2].endSec).toBe(90); // last pinned to the episode end
    // Contiguous: each cue starts where the previous ended.
    expect(placed[1].startSec).toBeCloseTo(placed[0].endSec, 5);
    expect(placed[2].startSec).toBeCloseTo(placed[1].endSec, 5);
  });

  it('ignores a cue rendered durationSec for span — tiles by count, not render length', () => {
    // Cues are typically rendered with engine-default lengths (12–20s) BEFORE
    // stitch placement; honoring those would collapse early cues to short spans
    // and dump the rest on the last cue. The muxer loops each cue to fill its
    // placed span, so span is purely "share of the episode," set by count.
    const cues = [
      { id: 'a', durationSec: 12 },
      { id: 'b', durationSec: 18 },
      { id: 'c', durationSec: 15 },
    ];
    const placed = placeCuesOnTimeline(cues, 90);
    expect(placed[0].endSec).toBeCloseTo(30, 5); // NOT 12
    expect(placed[1].startSec).toBeCloseTo(30, 5);
    expect(placed[1].endSec).toBeCloseTo(60, 5); // NOT 30 (12+18)
    expect(placed[2].endSec).toBe(90);
  });

  it('gives a single cue the whole episode', () => {
    const placed = placeCuesOnTimeline([{ id: 'only', durationSec: 12 }], 75);
    expect(placed[0].startSec).toBe(0);
    expect(placed[0].endSec).toBe(75);
  });

  it('preserves cue identity fields (id/label/prompt) while adding timing', () => {
    const cues = [{ id: 'cue-001', label: 'Act I', prompt: 'pads' }];
    const placed = placeCuesOnTimeline(cues, 30);
    expect(placed[0]).toMatchObject({ id: 'cue-001', label: 'Act I', prompt: 'pads', startSec: 0, endSec: 30 });
  });
});
