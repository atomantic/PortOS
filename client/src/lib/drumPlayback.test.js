import { describe, it, expect } from 'vitest';
import { parseDrumChart, CELL_GLYPHS } from './drumNotation.js';
import {
  buildDrumSchedule, resolveLoopRange, resolvePlayhead,
  clampClickVolume, DEFAULT_CLICK_VOLUME,
} from './drumPlayback.js';

// Invented grooves only (privacy convention). Every assertion here is pure math
// over the parsed chart — no AudioContext is created anywhere in this suite.

// 2 bars at subdivision 1 keeps the arithmetic readable: one cell per beat.
const TWO_BARS = `time: 4/4
tempo: 120
subdivision: 1

# A
HH: xxxx
K: o---

# B
S: x-x-`;

const near = (a, b) => expect(a).toBeCloseTo(b, 6);

describe('buildDrumSchedule — timing', () => {
  it('spaces steps by beat/subdivision at the given bpm', () => {
    const chart = parseDrumChart('time: 4/4\nsubdivision: 4\n\nHH: x-x-x-x-x-x-x-x-');
    const { events, stepSec, barSec, beatSec, totalSec } = buildDrumSchedule(chart, { bpm: 120 });
    near(beatSec, 0.5);           // 120 bpm → 0.5s per notated beat
    near(stepSec, 0.125);         // 16ths
    near(barSec, 2);
    near(totalSec, 2);
    expect(events).toHaveLength(8);
    events.forEach((ev, i) => near(ev.startSec, i * 0.25));
  });

  it('honors the chart tempo when no bpm override is given', () => {
    const chart = parseDrumChart('tempo: 60\nsubdivision: 1\n\nK: oooo');
    const schedule = buildDrumSchedule(chart);
    expect(schedule.bpm).toBe(60);
    near(schedule.beatSec, 1);
    near(schedule.totalSec, 4);
  });

  it('falls back to 90 bpm for a headerless chart', () => {
    expect(buildDrumSchedule(parseDrumChart('K: o---')).bpm).toBe(90);
  });

  it('counts the time-signature denominator as the beat (6/8 counts eighths)', () => {
    const chart = parseDrumChart('time: 6/8\ntempo: 120\nsubdivision: 1\n\nHH: xxxxxx');
    const { beatSec, barSec, events } = buildDrumSchedule(chart);
    near(beatSec, 0.5);
    near(barSec, 3);          // six eighth-note beats
    near(events[5].startSec, 2.5);
  });

  it('lays consecutive bars end to end', () => {
    const { events, barSec } = buildDrumSchedule(parseDrumChart(TWO_BARS), { bpm: 120 });
    near(barSec, 2);
    const barB = events.filter((e) => e.bar === 2);
    expect(barB).toHaveLength(2);
    near(barB[0].startSec, 2);   // bar 2 step 0
    near(barB[1].startSec, 3);   // bar 2 step 2
  });

  it('expands a repeated block into real, separately-timed bars', () => {
    const chart = parseDrumChart('tempo: 120\nsubdivision: 1\n\n# A x3\nK: o---');
    const { events, totalSec } = buildDrumSchedule(chart);
    expect(events.map((e) => e.bar)).toEqual([1, 2, 3]);
    events.forEach((ev, i) => near(ev.startSec, i * 2));
    near(totalSec, 6);
  });

  it('returns an empty, usable schedule for an empty chart', () => {
    const schedule = buildDrumSchedule(parseDrumChart(''), { bpm: 100 });
    expect(schedule.events).toEqual([]);
    expect(schedule.totalSec).toBe(0);
    expect(schedule.loop).toBeNull();
  });
});

describe('buildDrumSchedule — velocity and glyph flags', () => {
  it('maps each glyph to its velocity', () => {
    const chart = parseDrumChart('subdivision: 3\n\nHH: xXogf-');
    const { events } = buildDrumSchedule(chart, { bpm: 120 });
    expect(events.map((e) => e.velocity)).toEqual([
      CELL_GLYPHS.x.velocity, CELL_GLYPHS.X.velocity, CELL_GLYPHS.o.velocity,
      CELL_GLYPHS.g.velocity, CELL_GLYPHS.f.velocity,
    ]);
    expect(events.map((e) => e.step)).toEqual([0, 1, 2, 3, 4]);
    // Accent > normal > ghost is the contract the synth relies on.
    expect(CELL_GLYPHS.X.velocity).toBeGreaterThan(CELL_GLYPHS.x.velocity);
    expect(CELL_GLYPHS.x.velocity).toBeGreaterThan(CELL_GLYPHS.g.velocity);
  });

  it('carries the open / accent / ghost / flam flags onto the event', () => {
    const { events } = buildDrumSchedule(parseDrumChart('subdivision: 2\n\nHH: oXgf'), { bpm: 120 });
    expect(events.map((e) => [e.open, e.accent, e.ghost, e.flam])).toEqual([
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
      [false, false, false, true],
    ]);
  });

  it('emits no event for a rest', () => {
    const { events } = buildDrumSchedule(parseDrumChart('subdivision: 1\n\nK: -o--'), { bpm: 120 });
    expect(events).toHaveLength(1);
    expect(events[0].step).toBe(1);
  });

  it('resolves each piece to its synth voice', () => {
    const { events } = buildDrumSchedule(parseDrumChart('subdivision: 1\n\nK: o---\nS: -x--\nCR: --x-'), { bpm: 120 });
    expect(events.map((e) => [e.piece, e.sound])).toEqual([
      ['K', 'kick'], ['S', 'snare'], ['CR', 'crash'],
    ]);
  });

  it('sorts simultaneous hits together by onset', () => {
    const { events } = buildDrumSchedule(parseDrumChart('subdivision: 1\n\nHH: xxxx\nK: o-o-'), { bpm: 120 });
    expect(events.map((e) => e.startSec)).toEqual([...events.map((e) => e.startSec)].sort((a, b) => a - b));
    expect(events.filter((e) => e.startSec === 0).map((e) => e.piece).sort()).toEqual(['HH', 'K']);
  });
});

describe('buildDrumSchedule — count-in', () => {
  it('prepends one click per beat, downbeat accented, and offsets the music', () => {
    const chart = parseDrumChart('time: 4/4\ntempo: 120\nsubdivision: 1\n\nK: o---');
    const { events, countInSec, totalSec } = buildDrumSchedule(chart, { countInBars: 1 });
    near(countInSec, 2);
    near(totalSec, 4);
    const countIn = events.filter((e) => e.countIn);
    expect(countIn).toHaveLength(4);
    expect(countIn.every((e) => e.piece === null)).toBe(true);
    expect(countIn.map((e) => e.sound)).toEqual(Array(4).fill('click'));
    expect(countIn[0].velocity).toBeGreaterThan(countIn[1].velocity);
    countIn.forEach((ev, i) => near(ev.startSec, i * 0.5));
    // The music starts after the count-in.
    const music = events.filter((e) => !e.countIn);
    near(music[0].startSec, 2);
    expect(music[0].bar).toBe(1);
  });

  it('supports 2 bars of count-in and clamps a silly value', () => {
    const chart = parseDrumChart('tempo: 120\nsubdivision: 1\n\nK: o---');
    near(buildDrumSchedule(chart, { countInBars: 2 }).countInSec, 4);
    near(buildDrumSchedule(chart, { countInBars: 99 }).countInSec, 8); // clamped to 4 bars
    near(buildDrumSchedule(chart, { countInBars: -3 }).countInSec, 0);
    expect(buildDrumSchedule(chart, { countInBars: 0 }).events.every((e) => !e.countIn)).toBe(true);
  });
});

describe('buildDrumSchedule — loop range', () => {
  const chart = parseDrumChart(`tempo: 120
subdivision: 1

# A
K: o---

# B
S: x---

# C
HH: x---`);

  it('covers only the looped bars, rebased to zero', () => {
    const { events, bars, loop, totalSec } = buildDrumSchedule(chart, { loop: { from: 2, to: 3 } });
    expect(loop).toEqual({ from: 2, to: 3 });
    expect(bars.map((b) => b.index)).toEqual([2, 3]);
    // Bar numbers stay the CHART's (playhead correctness), but time starts at 0.
    expect(events.map((e) => e.bar)).toEqual([2, 3]);
    near(events[0].startSec, 0);
    near(events[1].startSec, 2);
    near(totalSec, 4);
  });

  it('offsets a looped range by the count-in', () => {
    const { events, countInSec } = buildDrumSchedule(chart, { loop: { from: 3, to: 3 }, countInBars: 1 });
    near(countInSec, 2);
    const music = events.filter((e) => !e.countIn);
    expect(music.map((e) => e.bar)).toEqual([3]);
    near(music[0].startSec, 2);
  });

  it('covers the whole chart when loop is absent', () => {
    const { bars, loop } = buildDrumSchedule(chart, {});
    expect(loop).toBeNull();
    expect(bars).toHaveLength(3);
  });
});

describe('resolveLoopRange', () => {
  it('returns null with no loop or no bars', () => {
    expect(resolveLoopRange(4, null)).toBeNull();
    expect(resolveLoopRange(0, { from: 1, to: 2 })).toBeNull();
  });

  it('clamps to the real bar count', () => {
    expect(resolveLoopRange(4, { from: 0, to: 99 })).toEqual({ from: 1, to: 4 });
    expect(resolveLoopRange(4, { from: 9, to: 9 })).toEqual({ from: 4, to: 4 });
  });

  it('normalizes a reversed range instead of rejecting it', () => {
    expect(resolveLoopRange(8, { from: 6, to: 2 })).toEqual({ from: 2, to: 6 });
  });

  it('defaults a missing endpoint to the full span', () => {
    expect(resolveLoopRange(5, {})).toEqual({ from: 1, to: 5 });
    expect(resolveLoopRange(5, { from: 3 })).toEqual({ from: 3, to: 5 });
  });
});

describe('resolvePlayhead', () => {
  // 2 bars at subdivision 1, 120 bpm → 0.5s/beat, 2s/bar, 4s total.
  const chart = parseDrumChart(TWO_BARS);
  const schedule = buildDrumSchedule(chart, { bpm: 120 });

  it('places a mid-bar position as a FRACTIONAL step, not a quantized one', () => {
    // 2.75s in = bar 2 (starts at 2s), 0.75s into it = 1.5 steps.
    const head = resolvePlayhead(schedule, 2.75);
    expect(head).toMatchObject({ countIn: false, bar: 2 });
    near(head.stepFloat, 1.5);
  });

  it('keeps moving through a bar with no hits at all', () => {
    // The onStep callback would stall here (no events to report); the clock
    // does not. A rest-only bar 2 still resolves to a position inside bar 2.
    const silent = buildDrumSchedule(parseDrumChart('time: 4/4\ntempo: 120\nsubdivision: 1\n\n# A\nK: o---\n\n# B\nK: ----'), { bpm: 120 });
    expect(resolvePlayhead(silent, 3).bar).toBe(2);
  });

  it('reports the count-in as a beat within its bar', () => {
    const withCount = buildDrumSchedule(chart, { bpm: 120, countInBars: 1 });
    expect(resolvePlayhead(withCount, 0)).toMatchObject({ countIn: true, beat: 1 });
    expect(resolvePlayhead(withCount, 1.2)).toMatchObject({ countIn: true, beat: 3 });
    // The transport's pre-roll lead runs NEGATIVE before t=0 — that's still the
    // first beat of the count-in, never a beat counted backwards.
    expect(resolvePlayhead(withCount, -0.1)).toMatchObject({ countIn: true, beat: 1 });
    // …and the music starts at the end of the count-in, rebased to bar 1.
    expect(resolvePlayhead(withCount, 2)).toMatchObject({ countIn: false, bar: 1, stepFloat: 0 });
  });

  it('reports the CHART bar number for a looped range, not the slice index', () => {
    // Loop bars 2–2: the schedule holds one bar, but the sheet must light bar 2.
    const looped = buildDrumSchedule(chart, { bpm: 120, loop: { from: 2, to: 2 } });
    expect(resolvePlayhead(looped, 0.5)).toMatchObject({ bar: 2 });
    // A looping player runs past its own length forever — pass 3 folds back on.
    expect(resolvePlayhead(looped, 6.5)).toMatchObject({ bar: 2 });
    near(resolvePlayhead(looped, 6.5).stepFloat, 1);
  });

  it('clamps a one-shot position at the final step instead of running off the end', () => {
    const head = resolvePlayhead(schedule, 99);
    expect(head.bar).toBe(2);
    expect(head.stepFloat).toBeLessThanOrEqual(4);
  });

  it('returns null when there is nothing to place', () => {
    expect(resolvePlayhead(null, 1)).toBeNull();
    expect(resolvePlayhead(buildDrumSchedule(parseDrumChart(''), {}), 1)).toBeNull();
  });
});

describe('clampClickVolume', () => {
  it('clamps a level into 0–1', () => {
    expect(clampClickVolume(0.4)).toBe(0.4);
    expect(clampClickVolume(0)).toBe(0);
    expect(clampClickVolume(1)).toBe(1);
    expect(clampClickVolume(2.5)).toBe(1);
    expect(clampClickVolume(-3)).toBe(0);
    expect(clampClickVolume('0.75')).toBe(0.75);
  });

  it('returns null — not silence — for a value that was never set', () => {
    // The sentinel contract: a caller falls back to DEFAULT_CLICK_VOLUME on null.
    // `Number('')` and `Number(null)` are both 0, so collapsing them into the
    // band would turn "no stored preference" into a muted metronome.
    for (const absent of [null, undefined, '', 'loud', NaN, {}]) {
      expect(clampClickVolume(absent)).toBeNull();
    }
    expect(DEFAULT_CLICK_VOLUME).toBe(1); // the fallback is FULL, never silence
  });
});
// @vitest-environment node
