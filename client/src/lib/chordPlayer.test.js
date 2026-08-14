import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseTabSheet } from './tabNotation.js';
import { createChordPlayer } from './chordPlayback.js';
import { createFakeAudio } from '../test/fakeAudioContext.js';

// The AUDIBLE half of chordPlayback.js — buildChordSchedule's pure math is
// covered in chordPlayback.test.js with no Web Audio at all. This suite drives
// the real lookahead transport against the shared Web Audio fake, so the wiring
// (tones actually scheduled, the strum offset, the click gate, the highlight
// callback, teardown) is pinned rather than assumed.
//
// One fake pair for the whole file — lib/audioContext.js caches the context.
const { FakeAudioContext, audio } = createFakeAudio();

// Advance the audio clock relatively, ticking the lookahead interval alongside.
const drive = (deltaSec) => {
  const target = audio.now + deltaSec;
  for (let t = audio.now + 0.05; t <= target + 1e-9; t += 0.05) {
    audio.now = Number(t.toFixed(4));
    vi.advanceTimersByTime(50);
  }
};

// Invented placeholder sheet (privacy convention): two chords, one per bar.
const SHEET = parseTabSheet('C        G\nNonsense lyric line').lines;

// The metronome blip is the only voice above 1kHz — no chord tone reaches it
// (the voicing tops out around MIDI 62, ~294 Hz).
const clicks = () => audio.oscillators.filter((o) => o.frequency?.values[0] >= 1000);
const chordTones = () => audio.oscillators.filter((o) => o.frequency?.values[0] < 1000);

describe('createChordPlayer', () => {
  beforeEach(() => {
    audio.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('sounds every note of every chord and finishes with onEnded', async () => {
    const ended = vi.fn();
    // 240 bpm, 4 beats per chord → 1s per chord, 2s total.
    const player = createChordPlayer(SHEET, { bpm: 240, onEnded: ended });
    await player.play();
    drive(3);
    // Two triads, each voiced as bass + three chord tones.
    expect(chordTones()).toHaveLength(8);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(player.isPlaying()).toBe(false);
  });

  it('strums rather than blocking the chord — each tone starts after the one below', async () => {
    const player = createChordPlayer(parseTabSheet('Am').lines, { bpm: 240 });
    await player.play();
    drive(1.5);
    const starts = chordTones().map((o) => o.started);
    expect(starts).toHaveLength(4);
    // The bass shares the downbeat; the chord tones sweep up from it.
    expect(starts[1]).toBeCloseTo(starts[0], 6);
    expect(starts[2]).toBeGreaterThan(starts[1]);
    expect(starts[3]).toBeGreaterThan(starts[2]);
    // …but the whole strum stays well inside one chord (it must read as a chord).
    expect(starts.at(-1) - starts[0]).toBeLessThan(0.1);
  });

  it('reports the sounding chord index for the sheet highlight, then clears it', async () => {
    const onChord = vi.fn();
    const player = createChordPlayer(SHEET, { bpm: 240, onChord });
    await player.play();
    drive(0.5);
    expect(onChord).toHaveBeenLastCalledWith(0);
    drive(1);
    expect(onChord).toHaveBeenLastCalledWith(1);
    drive(2);
    // A finished run must not leave the last chord lit.
    expect(onChord).toHaveBeenLastCalledWith(null);
  });

  it('stays silent through a chord with no voicing but keeps its place', async () => {
    const player = createChordPlayer(parseTabSheet('C   N.C.   G').lines, { bpm: 240 });
    await player.play();
    drive(4);
    // Only the two real chords sound — the N.C. bar passes in silence.
    expect(chordTones()).toHaveLength(8);
  });

  it('counts in with clicks even when the metronome is off', async () => {
    const player = createChordPlayer(SHEET, { bpm: 240, countInBars: 1, clickEnabled: false });
    await player.play();
    drive(1.5);
    // One bar of count-in = 4 blips, every one of them ahead of the first chord.
    expect(clicks()).toHaveLength(4);
    const firstChord = Math.min(...chordTones().map((o) => o.started));
    expect(clicks().every((c) => c.started < firstChord)).toBe(true);
    player.stop();
  });

  it('adds a click on every beat of the music only while the metronome is on', async () => {
    const off = createChordPlayer(SHEET, { bpm: 240, clickEnabled: false });
    await off.play();
    drive(3);
    expect(clicks()).toHaveLength(0);

    audio.reset();
    const on = createChordPlayer(SHEET, { bpm: 240, clickEnabled: true });
    await on.play();
    drive(3);
    // 2 chords × 4 beats.
    expect(clicks()).toHaveLength(8);
  });

  it('rebuilds on a tempo change made while idle, and leaves live audio alone', async () => {
    const player = createChordPlayer(SHEET, { bpm: 240 });
    expect(player.schedule().totalSec).toBeCloseTo(2, 6);
    player.setBpm(120);
    expect(player.schedule().totalSec).toBeCloseTo(4, 6);

    await player.play();
    drive(0.5);
    const during = player.schedule().totalSec;
    player.setBpm(240);
    // The running schedule is untouched — a live rebase would desync the
    // highlight from what is already scheduled to sound.
    expect(player.schedule().totalSec).toBe(during);
    player.stop();
  });

  it('schedules nothing more once stopped', async () => {
    const player = createChordPlayer(SHEET, { bpm: 240 });
    await player.play();
    drive(0.5);
    const sounded = audio.oscillators.length;
    expect(sounded).toBeGreaterThan(0);
    player.stop();
    expect(player.isPlaying()).toBe(false);
    // Every scheduled voice carries a stop time, and the drained interval adds
    // no more — a transport that kept its timer would keep sounding the sheet.
    expect(audio.oscillators.every((o) => o.stopped !== null)).toBe(true);
    drive(3);
    expect(audio.oscillators).toHaveLength(sounded);
  });

  it('never starts for a sheet with no chords', async () => {
    const ended = vi.fn();
    const player = createChordPlayer(parseTabSheet('just some words here').lines, { onEnded: ended });
    await player.play();
    drive(1);
    expect(audio.oscillators).toHaveLength(0);
    expect(player.isPlaying()).toBe(false);
    expect(ended).toHaveBeenCalled();
  });
});
