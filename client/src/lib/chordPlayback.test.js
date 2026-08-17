import { describe, it, expect } from 'vitest';
import { parseTabSheet } from './tabNotation.js';
import {
  buildChordSchedule, chordMidiNotes, resolveChordPlayhead, sheetChordOccurrences,
  DEFAULT_CHORD_TEMPO, DEFAULT_CHORD_BEATS_PER_BAR,
} from './chordPlayback.js';

// Invented placeholder sheets only (privacy convention). Every assertion here is
// pure math over the parsed sheet — no AudioContext is created in this suite.

const lines = (text) => parseTabSheet(text).lines;

// Two chord lines, four tokens.
const SHEET = `[Verse 1]
C        G
Nonsense lyric line

Am       F`;

const near = (a, b) => expect(a).toBeCloseTo(b, 6);

describe('sheetChordOccurrences', () => {
  it('flattens chord tokens in reading order with their line/chord coordinates', () => {
    const found = sheetChordOccurrences(lines(SHEET));
    expect(found.map((o) => o.name)).toEqual(['C', 'G', 'Am', 'F']);
    // Line 1 is the "C  G" line; the blank + lyric lines carry no chords, so the
    // second chord line is line 4 of the source.
    expect(found.map((o) => o.lineIndex)).toEqual([1, 1, 4, 4]);
    expect(found.map((o) => o.chordIndex)).toEqual([0, 1, 0, 1]);
  });

  it('splits a dash-joined quick change into segments that share one token', () => {
    const found = sheetChordOccurrences(lines('Am-Am7   F'));
    expect(found.map((o) => o.name)).toEqual(['Am', 'Am7', 'F']);
    // Both halves address the SAME token, so the sheet lights it for both.
    expect(found.slice(0, 2).map((o) => o.chordIndex)).toEqual([0, 0]);
    expect(found.slice(0, 2).map((o) => o.segments)).toEqual([2, 2]);
    expect(found[2].chordIndex).toBe(1);
  });

  it('reads ChordPro inline chords as well as chord lines', () => {
    expect(sheetChordOccurrences(lines('[C]Hello [G]world')).map((o) => o.name))
      .toEqual(['C', 'G']);
  });

  it('ignores tab staffs, lyrics and prose', () => {
    expect(sheetChordOccurrences(lines('e|--3--2--|\njust some words here'))).toEqual([]);
  });

  it('never throws on a missing or malformed line list', () => {
    expect(sheetChordOccurrences(null)).toEqual([]);
    expect(sheetChordOccurrences([{ type: 'text', text: 'x' }])).toEqual([]);
  });
});

describe('chordMidiNotes', () => {
  it('voices a triad as a bass note under the chord tones', () => {
    // C major: bass C2 (36) then C3 (48) E3 (52) G3 (55).
    expect(chordMidiNotes('C')).toEqual([36, 48, 52, 55]);
  });

  it('honours a slash bass without changing the chord above it', () => {
    const plain = chordMidiNotes('C');
    const slashed = chordMidiNotes('C/G');
    expect(slashed.slice(1)).toEqual(plain.slice(1));
    expect(slashed[0]).toBe(36 + 7); // G2
  });

  it('keeps an extension above the octave rather than folding it into a cluster', () => {
    // add9 is 14 semitones up, not 2.
    expect(chordMidiNotes('Cadd9')).toContain(48 + 14);
  });

  it('returns null for a token with no voicing, so the bar becomes a rest', () => {
    expect(chordMidiNotes('N.C.')).toBeNull();
    expect(chordMidiNotes('not a chord')).toBeNull();
  });
});

describe('buildChordSchedule — timing', () => {
  it('gives every chord token one bar at the requested tempo', () => {
    const { events, beatSec, barSec, totalSec } = buildChordSchedule(lines(SHEET), { bpm: 120 });
    near(beatSec, 0.5);
    near(barSec, 2);
    expect(events.map((e) => e.name)).toEqual(['C', 'G', 'Am', 'F']);
    expect(events.map((e) => e.startSec)).toEqual([0, 2, 4, 6]);
    near(totalSec, 8);
  });

  it('splits a dash-joined token\'s bar between its segments', () => {
    const { events } = buildChordSchedule(lines('Am-Am7   F'), { bpm: 120 });
    expect(events.map((e) => e.durSec)).toEqual([1, 1, 2]);
    expect(events.map((e) => e.startSec)).toEqual([0, 1, 2]);
  });

  it('honours beatsPerBar and clamps an out-of-range value to the default', () => {
    near(buildChordSchedule(lines('Am'), { bpm: 60, beatsPerBar: 3 }).barSec, 3);
    // 99 is outside CHORD_BEATS_MAX — clamped, never accepted as-is.
    expect(buildChordSchedule(lines('Am'), { beatsPerBar: 99 }).beatsPerBar).toBe(12);
    expect(buildChordSchedule(lines('Am'), { beatsPerBar: 'nonsense' }).beatsPerBar)
      .toBe(DEFAULT_CHORD_BEATS_PER_BAR);
  });

  it('falls back to the default tempo for a missing or nonsense bpm', () => {
    expect(buildChordSchedule(lines('Am'), {}).bpm).toBe(DEFAULT_CHORD_TEMPO);
    expect(buildChordSchedule(lines('Am'), { bpm: 0 }).bpm).toBe(DEFAULT_CHORD_TEMPO);
  });

  it('offsets the music by the count-in and emits one click per count-in beat', () => {
    const { events, clicks, countInSec } = buildChordSchedule(lines('C   G'), {
      bpm: 120, countInBars: 1,
    });
    near(countInSec, 2);
    expect(clicks).toHaveLength(4);
    expect(clicks[0].accent).toBe(true);
    expect(clicks.slice(1).every((c) => !c.accent)).toBe(true);
    expect(events[0].startSec).toBe(2);
  });

  it('clamps the count-in rather than accepting an unbounded lead-in', () => {
    expect(buildChordSchedule(lines('Am'), { countInBars: 99 }).clicks.length)
      .toBe(4 * 4); // CHORD_COUNT_IN_MAX bars × 4 beats
    expect(buildChordSchedule(lines('Am'), { countInBars: -3 }).clicks).toEqual([]);
  });

  it('marks an unvoiceable token as a rest that still occupies its bar', () => {
    const { events, totalSec } = buildChordSchedule(lines('C   N.C.   G'), { bpm: 120 });
    expect(events.map((e) => e.rest)).toEqual([false, true, false]);
    expect(events[1].midis).toEqual([]);
    near(totalSec, 6); // the rest still takes a full bar
  });

  it('reports zero length for a sheet with no chords at all', () => {
    const { events, totalSec } = buildChordSchedule(lines('just some words here'));
    expect(events).toEqual([]);
    expect(totalSec).toBe(0);
  });
});

describe('resolveChordPlayhead', () => {
  const schedule = buildChordSchedule(lines(SHEET), { bpm: 120, countInBars: 1 });

  it('reports the count-in beat before the music starts', () => {
    expect(resolveChordPlayhead(schedule, 0)).toEqual({ countIn: true, beat: 1 });
    expect(resolveChordPlayhead(schedule, 1.2)).toEqual({ countIn: true, beat: 3 });
  });

  it('clamps the transport\'s negative pre-roll to the first count-in beat', () => {
    expect(resolveChordPlayhead(schedule, -0.4)).toEqual({ countIn: true, beat: 1 });
  });

  it('reports the sounding chord index once the music is running', () => {
    expect(resolveChordPlayhead(schedule, 2.1).index).toBe(0);
    expect(resolveChordPlayhead(schedule, 4.1).index).toBe(1);
    expect(resolveChordPlayhead(schedule, 8.1).index).toBe(3);
  });

  it('holds on the last chord past the end rather than running off the list', () => {
    expect(resolveChordPlayhead(schedule, 999).index).toBe(3);
  });

  it('never reports a count-in for a schedule that has none, pre-roll included', () => {
    // The transport's lead makes `pos` briefly negative. With no count-in bars
    // that must still read as bar 1 beat 1 — not as a phantom count-in.
    const noCountIn = buildChordSchedule(lines(SHEET), { bpm: 120 });
    expect(resolveChordPlayhead(noCountIn, -0.08)).toEqual({ countIn: false, index: 0, beat: 1 });
    expect(resolveChordPlayhead(noCountIn, 0)).toEqual({ countIn: false, index: 0, beat: 1 });
  });

  it('returns null when there is nothing to place', () => {
    expect(resolveChordPlayhead(buildChordSchedule(lines('words only')), 1)).toBeNull();
    expect(resolveChordPlayhead(null, 1)).toBeNull();
  });
});
// @vitest-environment node
